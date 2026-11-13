import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, renderErrorPage, renderLoginPage } from "../../src/http/views.ts";

test("views escape", () => {
  const html = renderErrorPage("<script>alert(1)</script>");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("escapeHtml covers attribute breakers", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("login page escapes the uid, the value and the error", () => {
  const html = renderLoginPage({
    uid: 'u"><script>',
    walletAddress: '"><img src=x>',
    error: "<b>bad</b>",
  });
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /Sign in with your wallet address/);
  assert.match(html, /placeholder="\$ilp\.interledger-test\.dev\/alice"/);
  assert.match(html, />Continue</);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});
