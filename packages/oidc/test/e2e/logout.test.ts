import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CookieJar,
  SPA_CLIENT,
  startTestApp,
  WEB_CLIENT,
} from "../../../../test/support/test-app.ts";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

type Page = { url: string; status: number; html: string; headers: Headers };

/** Follows redirects like a browser and keeps the final response's headers. */
async function browse(jar: CookieJar, url: URL | string, init?: RequestInit): Promise<Page> {
  let current = new URL(url);
  let response = await jar.fetch(current, init);
  for (let hop = 0; hop < 10; hop++) {
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) break;
    await response.body?.cancel();
    current = new URL(location, current);
    response = await jar.fetch(current);
  }
  return {
    url: current.href,
    status: response.status,
    html: await response.text(),
    headers: response.headers,
  };
}

async function confirm(
  app: { url: string },
  jar: CookieJar,
  query: string,
): Promise<{ html: string; headers: Headers; action: URL; xsrf: string }> {
  const page = await browse(jar, `${app.url}/session/end?${query}`);
  assert.equal(page.status, 200, page.html);
  const action = /<form[^>]*action="([^"]+)"/.exec(page.html)?.[1];
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.html)?.[1];
  assert.ok(action && xsrf, page.html);
  return { html: page.html, headers: page.headers, action: new URL(action, page.url), xsrf };
}

function submit(jar: CookieJar, action: URL, fields: Record<string, string>): Promise<Page> {
  return browse(jar, action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

test("logout confirmation is our page with our headers", async (t) => {
  const app = await startTestApp(t, {
    clients: [{ ...WEB_CLIENT, client_name: "Example <App>" }, SPA_CLIENT],
  });
  const { jar } = await app.login();
  const page = await confirm(app, jar, "client_id=web");
  assert.equal(page.headers.get("content-security-policy"), CSP);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.html, /Example &lt;App&gt;<\/strong> is signing you out/);
  assert.match(page.html, /End my sign-in here/);
  assert.doesNotMatch(page.html, /<script/);
});

test("ending the sign-in here ends the provider session", async (t) => {
  const app = await startTestApp(t);
  const { jar } = await app.login();
  const { action, xsrf } = await confirm(app, jar, "client_id=web");
  const done = await submit(jar, action, { xsrf, logout: "yes" });
  assert.equal(done.status, 200, done.html);
  assert.match(done.html, /You're signed out<\/h1>/);
  assert.equal(done.headers.get("content-security-policy"), CSP);
  const again = await app.login({ jar });
  assert.ok(again.interaction, "expected the sign-in page again");
});

test("only this app keeps the provider session", async (t) => {
  const app = await startTestApp(t);
  const { jar } = await app.login();
  const { action, xsrf } = await confirm(app, jar, "client_id=web");
  const done = await submit(jar, action, { xsrf });
  assert.equal(done.status, 200, done.html);
  assert.match(done.html, /You're signed out of web/);
  const again = await app.login({ jar });
  assert.equal(again.interaction, undefined);
  assert.equal(again.error, undefined);
});

test("logout without a client can only end the provider session", async (t) => {
  const app = await startTestApp(t);
  const { jar } = await app.login();
  const { html, action, xsrf } = await confirm(app, jar, "");
  assert.equal(html.match(/<button/g)?.length, 1);
  const done = await submit(jar, action, { xsrf, logout: "yes" });
  assert.match(done.html, /You're signed out<\/h1>/);
  const again = await app.login({ jar });
  assert.ok(again.interaction, "expected the sign-in page again");
});

test("logout without a session still auto-submits", async (t) => {
  const app = await startTestApp(t);
  const page = await browse(new CookieJar(), `${app.url}/session/end?client_id=web`);
  assert.equal(page.status, 200);
  assert.match(page.html, /<script/);
  const csp = page.headers.get("content-security-policy");
  assert.ok(csp === null || csp.includes("script-src"), `unexpected CSP ${csp}`);
});
