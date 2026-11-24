import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appNameOf,
  escapeHtml,
  renderErrorPage,
  renderLoginPage,
  renderLogoutPage,
  renderSignedOutPage,
} from "../src/views.ts";

test("views escape", () => {
  const html = renderErrorPage("<script>alert(1)</script>");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("escapeHtml covers attribute breakers", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("login page escapes the uid, the value, the error and the app name", () => {
  const html = renderLoginPage({
    uid: 'u"><script>',
    appName: "<i>App</i>",
    walletAddress: '"><img src=x>',
    error: "<b>bad</b>",
  });
  assert.doesNotMatch(html, /<script>|<img|<b>|<i>/);
  assert.match(html, /Welcome/);
  assert.match(
    html,
    /Sign in to <strong>&lt;i&gt;App&lt;\/i&gt;<\/strong> with your wallet address/,
  );
  assert.match(html, /name="wallet_address"/);
  assert.match(html, /placeholder="\$ilp\.interledger-test\.dev\/alice"/);
  assert.match(html, />Continue</);
  assert.match(html, /role="alert"[^>]*>&lt;b&gt;bad&lt;\/b&gt;/);
  assert.match(html, /aria-invalid="true"/);
});

test("login page without an error marks nothing invalid", () => {
  const html = renderLoginPage({ uid: "u", appName: "App" });
  assert.doesNotMatch(html, /role="alert"|aria-invalid/);
});

test("pages carry the brand and no script", () => {
  for (const html of [renderLoginPage({ uid: "u", appName: "App" }), renderErrorPage("x")]) {
    assert.match(html, /Open Payments/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<style>/);
    assert.doesNotMatch(html, /<script|\son[a-z]+=|https?:\/\/fonts\./i);
  }
});

test("error page shows the title and message", () => {
  const html = renderErrorPage("Start again from the app.", "Login expired");
  assert.match(html, /<title>Login expired<\/title>/);
  assert.match(html, /<h1[^>]*>Login expired<\/h1>/);
  assert.match(html, /Start again from the app\./);
});

test("appNameOf prefers client_name and falls back to client_id", () => {
  assert.equal(appNameOf({ clientId: "web", clientName: "Web" }), "Web");
  assert.equal(appNameOf({ clientId: "web", clientName: "" }), "web");
  assert.equal(appNameOf({ clientId: "web" }), "web");
  assert.equal(appNameOf(undefined), undefined);
});

const FORM =
  '<form id="op.logoutForm" method="post" action="/session/end/confirm"><input type="hidden" name="xsrf" value="abc"/></form>';

test("logout page embeds the form and names the app, escaped", () => {
  const html = renderLogoutPage({ form: FORM, appName: "<i>App</i>" });
  assert.ok(html.includes(FORM));
  assert.match(html, /<strong>&lt;i&gt;App&lt;\/i&gt;<\/strong> is signing you out/);
  assert.match(
    html,
    /<button[^>]*form="op\.logoutForm"[^>]*name="logout"[^>]*value="yes"[^>]*>End my sign-in here</,
  );
  assert.match(
    html,
    /<button(?![^>]*name=)[^>]*form="op\.logoutForm"[^>]*>Only sign out of &lt;i&gt;App&lt;\/i&gt;</,
  );
  assert.doesNotMatch(html, /<script|<i>/);
});

test("logout page without an app offers only the full sign-out", () => {
  const html = renderLogoutPage({ form: FORM });
  assert.match(html, /An app is signing you out/);
  assert.match(html, /name="logout" value="yes"[^>]*>End my sign-in here</);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.doesNotMatch(html, /Only sign out|<strong><\/strong>/);
});

test("signed-out page has a variant per case", () => {
  assert.match(renderSignedOutPage({}), /You're signed out<\/h1>/);
  const withApp = renderSignedOutPage({ appName: "<i>App</i>" });
  assert.match(withApp, /You're signed out of &lt;i&gt;App&lt;\/i&gt;/);
  assert.match(withApp, /still signed in here/);
});

test("styles keep focus visible and long names inside buttons", () => {
  const css = /<style>([\s\S]*)<\/style>/.exec(renderLoginPage({ uid: "u", appName: "App" }))?.[1];
  assert.ok(css);
  // outline:none hides focus in forced-colors mode; translucent rings fall below 3:1 contrast.
  assert.doesNotMatch(css, /outline:none|outline[^;}]*rgba/);
  assert.match(css, /input:focus-visible\{[^}]*outline:2px solid #1f7f7c/);
  assert.match(css, /\.button\{[^}]*overflow-wrap:anywhere/);
});
