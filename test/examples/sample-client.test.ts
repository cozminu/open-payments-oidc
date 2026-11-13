import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createSampleClient } from "../../examples/sample-client.ts";
import { CookieJar, startTestApp, type TestApp, type TestAppOptions } from "../support/test-app.ts";

type Page = { url: string; status: number; html: string };

/** Serves the sample client on a random port; the handler is attached once it exists. */
async function listen(
  t: TestContext,
): Promise<{ origin: string; attach(h: RequestListener): void }> {
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => {
    if (handler === undefined) {
      res.writeHead(503).end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, attach: (h) => (handler = h) };
}

/** Follows redirects across every host like a browser, until a page that isn't a redirect. */
async function browse(jar: CookieJar, url: URL | string): Promise<Page> {
  let current = new URL(url);
  for (let hop = 0; hop < 10; hop++) {
    const response = await jar.fetch(current);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return { url: current.href, status: response.status, html: await response.text() };
  }
  throw new Error(`too many redirects, last at ${current.href}`);
}

async function startSample(
  t: TestContext,
  options: TestAppOptions = {},
): Promise<{ app: TestApp; origin: string }> {
  const sample = await listen(t);
  const app = await startTestApp(t, {
    ...options,
    clients: [
      {
        client_id: "sample",
        token_endpoint_auth_method: "none",
        redirect_uris: [`${sample.origin}/callback`],
        post_logout_redirect_uris: [`${sample.origin}/`],
      },
    ],
  });
  sample.attach(
    createSampleClient({
      issuer: app.issuer,
      clientId: "sample",
      redirectUri: `${sample.origin}/callback`,
      log: () => {},
    }),
  );
  return { app, origin: sample.origin };
}

/** Starts at the sample's /login, submits the wallet address and returns the final sample page. */
async function signIn(
  app: TestApp,
  origin: string,
  path = "/login",
  jar = new CookieJar(),
): Promise<Page> {
  const form = await browse(jar, `${origin}${path}`);
  assert.equal(form.status, 200);
  assert.match(form.html, /Sign in with your wallet address/);
  const submitted = await jar.fetch(form.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ wallet_address: app.fake.walletAddress }).toString(),
  });
  const location = submitted.headers.get("location");
  await submitted.body?.cancel();
  assert.equal(submitted.status, 303);
  assert.ok(location);
  const callback = await app.fake.interact(new URL(location, form.url).href);
  return browse(jar, callback);
}

test("home page links to sign in", async (t) => {
  const { origin } = await startSample(t);
  const response = await fetch(`${origin}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /href="\/login"/);
  assert.match(html, /href="\/login\?prompt=login"/);
});

test("full login shows verified claims and userinfo", async (t) => {
  const { app, origin } = await startSample(t);
  const page = await signIn(app, origin);
  assert.equal(page.status, 200);
  assert.equal(new URL(page.url).origin, origin);
  assert.match(page.html, /Signed in/);
  const wallet = app.fake.walletAddress;
  assert.match(page.html, new RegExp(`&quot;sub&quot;: &quot;${wallet}&quot;`));
  assert.match(page.html, new RegExp(`&quot;wallet_address&quot;: &quot;${wallet}&quot;`));
  assert.match(page.html, /&quot;aud&quot;: &quot;sample&quot;/);
  assert.match(page.html, /Userinfo/);
  assert.match(page.html, /&quot;alg&quot;: &quot;RS256&quot;/);
});

test("prompt=login is passed to the provider", async (t) => {
  const { app, origin } = await startSample(t);
  const page = await signIn(app, origin, "/login?prompt=login");
  assert.match(page.html, /Signed in/);
});

test("wallet denial shows the error", async (t) => {
  const { app, origin } = await startSample(t, { fake: { approval: "reject" } });
  const page = await signIn(app, origin);
  assert.equal(page.status, 400);
  assert.match(page.html, /access_denied/);
});

test("logout ends the provider session and returns home", async (t) => {
  const { app, origin } = await startSample(t);
  const jar = new CookieJar();
  await signIn(app, origin, "/login", jar);
  const home = await browse(jar, `${origin}/`);
  assert.match(home.html, new RegExp(`Signed in as ${app.fake.walletAddress}`));
  assert.match(home.html, /href="\/logout"/);

  // The provider asks for confirmation; submit its form like a browser would.
  const confirm = await browse(jar, `${origin}/logout`);
  assert.equal(new URL(confirm.url).origin, app.url);
  const action = /<form[^>]*action="([^"]+)"/.exec(confirm.html)?.[1];
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(confirm.html)?.[1];
  assert.ok(action && xsrf, confirm.html);
  const submitted = await jar.fetch(new URL(action, confirm.url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ xsrf, logout: "yes" }).toString(),
  });
  const location = submitted.headers.get("location");
  await submitted.body?.cancel();
  assert.ok(location);
  const after = await browse(jar, new URL(location, confirm.url));
  assert.equal(after.url, `${origin}/`);
  assert.match(after.html, /Not signed in/);

  // With the provider session gone, signing in asks for the wallet again.
  const again = await signIn(app, origin, "/login", jar);
  assert.match(again.html, /Signed in/);
});

test("logout without a sample session still goes to the provider", async (t) => {
  const { app, origin } = await startSample(t);
  const response = await fetch(`${origin}/logout`, { redirect: "manual" });
  await response.body?.cancel();
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, `${app.url}/session/end`);
  assert.equal(location.searchParams.get("client_id"), "sample");
  assert.equal(location.searchParams.get("post_logout_redirect_uri"), `${origin}/`);
  assert.equal(location.searchParams.get("id_token_hint"), null);
});

test("callback with an unknown state is refused", async (t) => {
  const { origin } = await startSample(t);
  const response = await fetch(`${origin}/callback?code=abc&state=nope`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown or already used state/);
});

test("unknown path is 404", async (t) => {
  const { origin } = await startSample(t);
  const response = await fetch(`${origin}/nope`);
  await response.body?.cancel();
  assert.equal(response.status, 404);
});
