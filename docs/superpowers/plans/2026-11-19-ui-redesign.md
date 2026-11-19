# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every provider page (sign-in, errors, logout confirmation, signed out) in the
Interledger test wallet look, and the sample client in a neutral developer look, with HTML and
CSS only.

**Architecture:** Provider pages stay template strings in `src/http/views.ts`, sharing one page
shell and one inline stylesheet. Two new view functions back oidc-provider's
`logoutSource`/`postLogoutSuccessSource` hooks in `src/oidc/provider.ts`. Security headers move
into one exported constant so our own responses and the oidc-provider-rendered pages send the
same set. The sample client keeps its own shell and CSS in `examples/sample-client.ts`.

**Tech Stack:** Node 24 (runs `.ts` directly), oidc-provider 9, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`. Visual reference:
`.superpowers/brainstorm/93599-1795091593/content/provider-screens.html` and `sample-client.html`
(open them in a browser; they're gitignored).

## Global Constraints

- No JavaScript on any provider page we render. No `<script`, no `on*=` attributes.
- No React, bundler, build step, new dependency, external request (fonts, CSS), or font files.
- No real Open Payments / Interledger logo files. Brand = gradient square + text "Open Payments".
- Styles in an inline `<style>` block (CSP allows only `style-src 'unsafe-inline'`). No static
  file route.
- CSP stays exactly `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`.
- Never put our CSP on oidc-provider's auto-submit pages (no-session `/session/end`,
  `response_mode=form_post`).
- Every user- or config-supplied string in HTML goes through `escapeHtml`.
- No change to routes, flows, or status codes.
- Follow the existing style of each file you touch (these files use plain functions and
  `describe`-free tests, mostly; match what's there). Prettier width 100.
- Light theme only.
- Don't commit or create branches. The user hasn't asked for commits; each task ends with a
  green check instead.
- Every task's check: `npx prettier --check . && npm run typecheck && npm test`, all passing.

Provider palette (from the spec):

| Use                     | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| Page background         | `linear-gradient(135deg, #d8eeec 0%, #a0d5d5 55%, #36b3b0 100%)` |
| Card                    | `#fff`, radius about 14px, soft shadow               |
| Text                    | `#040607`; secondary a muted gray                    |
| Primary button          | `#da35ba` background, `#fff` text                    |
| Secondary button        | `#fff`, light gray border, `#040607` text            |
| Input border            | `#a0d5d5`                                            |
| Brand square            | `linear-gradient(135deg, #36b3b0, #da35ba)`          |

Sample client palette: `#0f172a` (top bar, primary button), `#f8fafc` (background), `#e2e8f0`
(borders), slate grays for secondary text, `#dcfce7`/`#166534` for the verified pills, red for
errors.

## Review Focus

1. Signing out with no provider session (expired, second logout): oidc-provider's auto-submit
   page must still work, so no CSP of ours on it. Pinned in Task 3.
2. A `client_name` with HTML in it (`Example <App>`) shows escaped on sign-in, logout and
   signed-out pages. Pinned in Tasks 2 and 3.
3. Logout reached without `client_id` or `id_token_hint`: no blank where the app name goes.
   Pinned in Task 3 (view tests with `appName` undefined).
4. A long wallet address or long error on a phone-width screen: no horizontal scroll (input and
   messages wrap or use `overflow-wrap: anywhere`). Checked by the visual step in Task 2.
5. Keyboard users: input and buttons show a visible focus ring on every provider page. Checked
   by the visual steps in Tasks 2 and 3 (tab through each page).

---

### Task 1: Optional `client_name` in the clients file

**Files:**
- Modify: `src/config/clients.ts` (type `ClientConfig`, `parseClient`)
- Modify: `config/clients.example.json`, `README.md` (Clients file table)
- Test: `test/config/clients.test.ts`

**Interfaces:**
- Produces: `ClientConfig.client_name?: string`. oidc-provider reads it as standard metadata and
  exposes it as `client.clientName`.

- [ ] **Step 1: Write the failing tests** in `test/config/clients.test.ts`, inside the existing
  `describe("loadClients")`, next to the other cases:

```ts
test("reads an optional client_name", () => {
  const clients = loadClients(
    write([
      { client_id: "a", client_secret: "x", redirect_uris: ["https://a.example/cb"], client_name: "App A" },
      { client_id: "b", client_secret: "x", redirect_uris: ["https://b.example/cb"] },
    ]),
  );
  assert.equal(clients[0]?.client_name, "App A");
  assert.equal("client_name" in (clients[1] ?? {}), false);
});

test("rejects an empty or non-string client_name", () => {
  for (const client_name of ["", 42]) {
    assert.throws(
      () =>
        loadClients(
          write([{ client_id: "a", client_secret: "x", redirect_uris: ["https://a.example/cb"], client_name }]),
        ),
      /Client "a" client_name must be a non-empty string/,
    );
  }
});
```

- [ ] **Step 2: Run** `node --test test/config/clients.test.ts`. Expected: the two new tests FAIL.
- [ ] **Step 3: Implement.** Add `client_name?: string` to `ClientConfig`. In `parseClient`,
  same pattern as `client_secret`: if `raw.client_name !== undefined`, require a non-empty
  string (error `` `${label} client_name must be a non-empty string` ``), then set it. Omit the
  key when absent.
- [ ] **Step 4: Docs.** Add `"client_name": "Example web app"` to the first client in
  `config/clients.example.json`. Add a README table row after `client_id`:
  `` `client_name` | no | Shown to users on the sign-in and logout pages. Default: the `client_id`. ``
  (run `npm run format` to realign the table).
- [ ] **Step 5: Check.** `npx prettier --check . && npm run typecheck && npm test`. Expected: all pass.

---

### Task 2: Provider page shell, sign-in and error pages

**Files:**
- Modify: `src/http/views.ts` (shell, stylesheet, `renderLoginPage`, `renderErrorPage`, new
  `SECURITY_HEADERS`, `appNameOf`)
- Modify: `src/http/interaction.ts` (`show`, `submit` pass `appName`; `sendHtml` uses
  `SECURITY_HEADERS`)
- Modify: `src/oidc/provider.ts` (`renderError` sets `SECURITY_HEADERS`)
- Test: `test/http/views.test.ts`, `test/e2e/login.test.ts`, `test/examples/sample-client.test.ts`

**Interfaces:**
- Consumes: `ClientConfig.client_name` (Task 1).
- Produces (all in `src/http/views.ts`):
  - `export const SECURITY_HEADERS: Readonly<Record<string, string>>` with exactly
    `content-security-policy`, `x-frame-options: DENY`, `referrer-policy: no-referrer`,
    `x-content-type-options: nosniff` (values as today in `sendHtml`).
  - `export function appNameOf(client: { clientId: string; clientName?: string } | undefined): string | undefined`
    returns `clientName` if non-empty, else `clientId`, else `undefined`.
  - `export type LoginPageOptions = { uid: string; appName: string; walletAddress?: string; error?: string }`
  - `renderLoginPage(options: LoginPageOptions): string`
  - `renderErrorPage(message: string, title = "Something went wrong"): string` (unchanged signature)
  - `function page(title: string, body: string): string` (private shell; Task 3 reuses it)

- [ ] **Step 1: Write the failing view tests** in `test/http/views.test.ts`. Change the existing
  login test to pass `appName: "<i>App</i>"` and replace its `/Sign in with your wallet address/`
  assertion. Add the others:

```ts
test("login page escapes the uid, the value, the error and the app name", () => {
  const html = renderLoginPage({
    uid: 'u"><script>',
    appName: "<i>App</i>",
    walletAddress: '"><img src=x>',
    error: "<b>bad</b>",
  });
  assert.doesNotMatch(html, /<script>|<img|<b>|<i>/);
  assert.match(html, /Welcome/);
  assert.match(html, /Sign in to <strong>&lt;i&gt;App&lt;\/i&gt;<\/strong> with your wallet address/);
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
```

- [ ] **Step 2: Write the failing e2e test** in `test/e2e/login.test.ts`, and replace the two
  `/Sign in with your wallet address/` assertions there (lines 28 and 116) with
  `/name="wallet_address"/`. Do the same in the `signIn` helper of
  `test/examples/sample-client.test.ts`.

```ts
test("sign-in page names the app, escaped, with security headers", async (t) => {
  const app = await startTestApp(t, {
    clients: [{ ...WEB_CLIENT, client_name: "Example <App>" }, SPA_CLIENT],
  });
  const result = await app.login();
  assert.match(result.interaction?.html ?? "", /Sign in to <strong>Example &lt;App&gt;<\/strong>/);
  const spa = await app.login({ client: "spa", jar: new CookieJar() });
  assert.match(spa.interaction?.html ?? "", /Sign in to <strong>spa<\/strong>/);
});

test("oidc-provider error pages get our headers", async (t) => {
  const app = await startTestApp(t);
  const response = await fetch(`${app.url}/auth?client_id=nope&response_type=code&scope=openid`);
  assert.equal(response.status, 400);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  assert.match(await response.text(), /Open Payments/);
});
```

  (Import `WEB_CLIENT`, `SPA_CLIENT` from `../support/test-app.ts`.)

- [ ] **Step 3: Run** `node --test test/http/views.test.ts test/e2e/login.test.ts`. Expected:
  the new and edited tests FAIL (missing export `appNameOf`, missing `appName` copy, no CSP on
  the error page).

- [ ] **Step 4: Implement the shell and pages in `src/http/views.ts`.** Markup for the
  card (match `provider-screens.html`): brand row (`<span class="mark" aria-hidden="true"></span>`
  + "Open Payments"), `<h1>`, body, footer "Powered by Open Payments" on the sign-in page only.
  Exact sign-in copy: heading `Welcome`; line
  `Sign in to <strong>${app}</strong> with your wallet address. You'll approve it at your wallet.`
  When `error` is set: input gets `aria-invalid="true" aria-describedby="wallet_address_error"`
  and the class for the red border; message is
  `<p id="wallet_address_error" class="error" role="alert">…</p>` under the input. Error page:
  an icon circle (`!`, pink tint `#fbe3f5` / `#b0218f`), `<h1>` title, `<p>` message, no
  footer. Stylesheet: palette from Global Constraints, system font stack, monospace for the
  input, visible `:focus-visible` outline on input and buttons, `overflow-wrap: anywhere` on
  messages, and a `@media (max-width: 480px)` rule where the card spans the width and the
  gradient becomes a band behind its top. Include the button styles for `.button` (primary)
  and `.button.secondary` now; Task 3 uses them.

- [ ] **Step 5: Wire it up.** In `interaction.ts`: `sendHtml` spreads `SECURITY_HEADERS` plus
  its own `content-type`, `content-length`, `cache-control`. `show` and `submit` get the app
  name with
  `appNameOf(await this.provider.Client.find(String(interaction.params.client_id))) ?? String(interaction.params.client_id)`
  (a private helper on `InteractionHandlers`, used by both). In `provider.ts` `renderError`:
  `ctx.set({ ...SECURITY_HEADERS, "cache-control": "no-store" })` before setting the body.

- [ ] **Step 6: Run the check.** `npx prettier --check . && npm run typecheck && npm test`. Expected: all pass.

- [ ] **Step 7: Visual check.** Render the pages to files and compare with
  `provider-screens.html` at desktop width and at 375px:

```sh
mkdir -p /tmp/ui && node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { renderLoginPage, renderErrorPage } from "./src/http/views.ts";
writeFileSync("/tmp/ui/login.html", renderLoginPage({ uid: "u", appName: "example-spa" }));
writeFileSync("/tmp/ui/login-error.html", renderLoginPage({ uid: "u", appName: "example-spa", walletAddress: "https://ilp.interledger-test.dev/a-really-long-wallet-address-that-keeps-going", error: "That doesn'\''t look like a wallet address." }));
writeFileSync("/tmp/ui/error.html", renderErrorPage("This login expired or was already used. Start again from the app.", "Login expired"));'
```

  Expected: looks like mockup screens 1, 2 and 5; no horizontal scroll at 375px.

---

### Task 3: Logout confirmation and signed-out pages

**Files:**
- Modify: `src/http/views.ts` (two new renderers)
- Modify: `src/oidc/provider.ts` (`features.rpInitiatedLogout`)
- Test: `test/http/views.test.ts`, create `test/e2e/logout.test.ts`

**Interfaces:**
- Consumes: `page`, `SECURITY_HEADERS`, `appNameOf`, button classes (Task 2).
- Produces:
  - `renderLogoutPage(options: { form: string; appName?: string }): string`. `form` is
    oidc-provider's trusted form HTML (`<form id="op.logoutForm" …>` with the `xsrf` input),
    inserted verbatim, not escaped.
  - `renderSignedOutPage(options: { appName?: string }): string`.

Exact copy (from the spec, finalized):

| Case | Text |
| --- | --- |
| Logout, app known | h1 `Sign out?`; `<strong>${app}</strong> is signing you out. Also end your sign-in here? If you do, other apps will ask you to approve at your wallet again.` Buttons `Sign out everywhere`, `Only sign out of ${app}` |
| Logout, app unknown | h1 `Sign out?`; `An app is signing you out. Also end your sign-in here? If you do, other apps will ask you to approve at your wallet again.` Buttons `Sign out everywhere`, `Only sign out of the app` |
| Signed out, no app | check icon; h1 `You're signed out`; `You can close this tab.` |
| Signed out, app | check icon; h1 `You're signed out of ${app}`; `You're still signed in here, so other apps won't ask you to approve again. You can close this tab.` |

Buttons: primary `<button type="submit" form="op.logoutForm" name="logout" value="yes" class="button" autofocus>`,
secondary `<button type="submit" form="op.logoutForm" class="button secondary">` (no name, so
oidc-provider keeps the provider session). Check icon uses the teal tint `#d8eeec` / `#1f7f7c`.

- [ ] **Step 1: Write the failing view tests** in `test/http/views.test.ts`:

```ts
const FORM = '<form id="op.logoutForm" method="post" action="/session/end/confirm"><input type="hidden" name="xsrf" value="abc"/></form>';

test("logout page embeds the form and names the app, escaped", () => {
  const html = renderLogoutPage({ form: FORM, appName: "<i>App</i>" });
  assert.ok(html.includes(FORM));
  assert.match(html, /<strong>&lt;i&gt;App&lt;\/i&gt;<\/strong> is signing you out/);
  assert.match(html, /<button[^>]*form="op\.logoutForm"[^>]*name="logout"[^>]*value="yes"[^>]*>Sign out everywhere</);
  assert.match(html, /<button(?![^>]*name=)[^>]*form="op\.logoutForm"[^>]*>Only sign out of &lt;i&gt;App&lt;\/i&gt;</);
  assert.doesNotMatch(html, /<script|<i>/);
});

test("logout page without an app has no blank name", () => {
  const html = renderLogoutPage({ form: FORM });
  assert.match(html, /An app is signing you out/);
  assert.match(html, />Only sign out of the app</);
  assert.doesNotMatch(html, /<strong><\/strong>|of <\//);
});

test("signed-out page has a variant per case", () => {
  assert.match(renderSignedOutPage({}), /You're signed out<\/h1>/);
  const withApp = renderSignedOutPage({ appName: "<i>App</i>" });
  assert.match(withApp, /You're signed out of &lt;i&gt;App&lt;\/i&gt;/);
  assert.match(withApp, /still signed in here/);
});
```

  (Fixed copy is written with literal apostrophes; only dynamic values go through `escapeHtml`.)

- [ ] **Step 2: Write the failing e2e tests** in a new `test/e2e/logout.test.ts`. Use
  `app.login()` (returns `jar`), then drive `/session/end` with that jar. `WEB_CLIENT` has no
  `post_logout_redirect_uris`, so the success page is ours to render. Helper at the top:
  `confirm(app, jar, query)` that GETs `${app.url}/session/end?${query}`, asserts 200, and
  returns `{ html, headers, action, xsrf }` (regexes as in `sample-client.test.ts`). Tests:

  - `"logout confirmation is our page with our headers"`: query `client_id=web` on an app whose
    web client has `client_name: "Example <App>"`. Assert CSP header equals the exact policy,
    `cache-control` is `no-store`, html matches `/Example &lt;App&gt;<\/strong> is signing you out/`
    and `/Sign out everywhere/`, no `<script`.
  - `"sign out everywhere ends the provider session"`: POST `xsrf` + `logout=yes` to `action`,
    follow the redirect; final page matches `/You're signed out<\/h1>/` and has the CSP
    header. Then `app.login({ jar })` shows an interaction page again (`result.interaction`
    defined).
  - `"only this app keeps the provider session"`: POST only `xsrf`; final page matches
    `/You're signed out of web/`. Then `app.login({ jar })` has `result.interaction`
    undefined (session reused) and no `error`.
  - `"logout without a session still auto-submits"`: fresh `CookieJar`, GET
    `${app.url}/session/end?client_id=web`. Assert 200, html contains `<script`, and the
    `content-security-policy` header is either absent or contains `script-src`. Never our
    policy.

- [ ] **Step 3: Run** `node --test test/http/views.test.ts test/e2e/logout.test.ts`. Expected:
  new tests FAIL (missing exports; default oidc-provider pages).

- [ ] **Step 4: Implement** `renderLogoutPage` and `renderSignedOutPage` in `views.ts` with
  `page()` and the copy table above. In `provider.ts`, set
  `features.rpInitiatedLogout` to `{ enabled: true, logoutSource, postLogoutSuccessSource }`,
  where each sets `ctx.type = "html"`,
  `ctx.set({ ...SECURITY_HEADERS, "cache-control": "no-store" })`, and
  `ctx.body = render…({ …, appName: appNameOf(ctx.oidc.client) })`. Leave the auto-submit path
  alone (oidc-provider never calls `logoutSource` there).

- [ ] **Step 5: Run the check.** `npx prettier --check . && npm run typecheck && npm test`. The
  existing `"logout ends the provider session and returns home"` sample-client test must still
  pass unchanged, since it parses the form `action` and `xsrf` out of our page.

- [ ] **Step 6: Visual check.** Add to the `/tmp/ui` script from Task 2:
  `logout.html` (`renderLogoutPage({ form: FORM, appName: "example-spa" })`),
  `signed-out.html` and `signed-out-app.html`. Compare with mockup screens 3 and 4.

---

### Task 4: Sample client restyle

**Files:**
- Modify: `examples/sample-client.ts` (`send` becomes the new shell; callback and home bodies)
- Test: `test/examples/sample-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it keeps its own `escapeHtml`; it isn't shipped with
  the service).
- Produces (module-private in `examples/sample-client.ts`):
  - `send(res, status, title, body, headers?, issuer, clientId)` or equivalent: the shell needs
    the issuer and client ID for the top bar chips, so pass them in (for example by making
    `send` a closure inside `createSampleClient`).
  - `claimsTable(claims: Record<string, unknown>): string`. One row per claim, in the token's
    order: `<tr><th scope="row">${key}</th><td>${value}</td></tr>`. Strings are shown as-is
    (escaped); everything else as `JSON.stringify(value)` (escaped). For `exp`, `iat` and
    `auth_time` when they're numbers, append `<span class="muted">${formatUtc(value)}</span>`.
  - `formatUtc(seconds: number): string` returns `YYYY-MM-DD HH:MM:SS UTC`.

Page content (match `sample-client.html`):

- Shell on every page: dark top bar with a link `Sample client` to `/` and two chips
  `issuer ${issuer}` and `client ${clientId}`; main column below. Keep `<meta name="viewport">`.
- Home, signed out: h1 `Not signed in`; line `A test relying party for the provider: authorization code flow with PKCE, then RP-initiated logout.`;
  buttons as links `<a class="button" href="/login">Sign in with your wallet</a>` and
  `<a class="button secondary" href="/login?prompt=login">Sign in, approving at the wallet again</a>`.
- Home, signed in: h1 `Signed in`; `Signed in as <code>${sub}</code>` and
  `<a class="button secondary" href="/logout">Log out</a>`.
- Callback: h1 `Signed in`; the wallet address row with Log out; pills
  `signature`, `issuer`, `audience`, `nonce`, `expiry` (each prefixed with a check mark); section
  "ID token claims" with `claimsTable`; then three `<details>` (collapsed): "ID token header",
  "Userinfo" (both pretty JSON in `<pre>`), "Raw ID token" (the compact JWT in `<pre>` with
  `overflow-wrap: anywhere`).
- Errors (login failed, unknown state, 404, 405, 500): h1 is the title, message in a red
  callout, then a `Back to home` link to `/`. The 405 and 404 bodies get a one-line message
  instead of being empty.

- [ ] **Step 1: Update and add tests** in `test/examples/sample-client.test.ts`. In
  `"full login shows verified claims and userinfo"`, replace the three claim assertions with:

```ts
assert.match(page.html, new RegExp(`<th scope="row">sub</th><td>${wallet}</td>`));
assert.match(page.html, new RegExp(`<th scope="row">wallet_address</th><td>${wallet}</td>`));
assert.match(page.html, /<th scope="row">aud<\/th><td>sample<\/td>/);
assert.match(page.html, /<th scope="row">exp<\/th><td>\d+ <span class="muted">\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC<\/span><\/td>/);
assert.match(page.html, /<details>\s*<summary>Raw ID token<\/summary>/);
assert.match(page.html, /Log out/);
```

  Keep the existing `/Userinfo/` and `&quot;alg&quot;: &quot;RS256&quot;` assertions (the header
  is still pretty JSON). Add to `"home page links to sign in"`:
  `assert.match(html, /Not signed in/)` and `assert.match(html, /client sample/)`. Add to
  `"unknown path is 404"`: the body matches `/Back to home/`. (`wallet` contains `.` and `/`,
  which are fine unescaped in these regexes because they only widen the match.)

- [ ] **Step 2: Run** `node --test test/examples/sample-client.test.ts`. Expected: the edited
  assertions FAIL.
- [ ] **Step 3: Implement** the shell, pages, `claimsTable` and `formatUtc` per the content
  list above. Palette from Global Constraints. System fonts, monospace for values.
- [ ] **Step 4: Run the check.** `npx prettier --check . && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Visual check.** Temporarily add
  `writeFileSync("/tmp/ui/sample-signed-in.html", page.html)` to the full-login test, run it,
  remove the line. Also `npm run sample-client` and open `http://localhost:5173/` and
  `/callback?state=x`. Compare with `sample-client.html`, including at 375px (claims table
  values wrap, no horizontal scroll).

---

## Final check

- [ ] `npx prettier --check . && npm run typecheck && npm test`: all pass.
- [ ] `grep -n "<script" src/http/views.ts examples/sample-client.ts`: no output.
- [ ] `git status`: only the files listed in the tasks changed, plus the spec and this plan.
  Nothing committed.
