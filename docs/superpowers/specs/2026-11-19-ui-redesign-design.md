# UI redesign: provider and sample client

Date: 2026-11-19

## Intent

The provider's pages and the sample client are bare unstyled HTML today. The goal is a modern,
clean look. For the provider, that means close to the Open Payments / Interledger test wallet
style. The sample client should look clearly different, because it plays the part of someone
else's app; when testing, you should see the redirect cross from the app to the provider and
back.

Mockups the user approved live in `.superpowers/brainstorm/*/content/` (gitignored):
`provider-screens.html` and `sample-client.html`. Treat them as the visual reference. The real
pages must match their look; the exact pixels are left to the builder.

## Goals

- Restyle every page the provider renders: sign-in, sign-in with an error, the generic error
  page (all its uses), and also the logout confirmation and signed-out pages, which are
  oidc-provider's built-in defaults today.
- Restyle every page the sample client renders: home (signed out and signed in), the callback
  result page, and its error pages.
- Look good on phones as well as desktop.

## Non-goals

- No change to the login, verification or logout flows, the routes, or the status codes.
- No dark mode.
- No new features in the sample client beyond the presentation listed below.

## Anti-goals (would be a failure even if it works)

- Any JavaScript on provider pages. The user chose HTML and CSS only to keep the sign-in page
  locked down. The current CSP (`default-src 'none'; style-src 'unsafe-inline';
  frame-ancestors 'none'`) stays as is.
- React, a bundler, or a build step. The user first wanted React, then dropped it once the JS
  tradeoff was clear. Node keeps running the `.ts` sources directly and the Dockerfile keeps
  copying `src` with no build stage.
- New runtime dependencies, external font or CSS requests (no Google Fonts), or shipped font
  files.
- Using the real Open Payments or Interledger logo files. Those are trademarks.

## Out of scope: oidc-provider's auto-submit pages

oidc-provider serves its own unstyled "Submitting Callback" page with an inline auto-submit
`<script>` in two cases: `/session/end` hit with no signed-in account (it skips `logoutSource`
and posts `logout=yes` itself), and clients using `response_mode=form_post`. These stay as they
are (my call). The no-JS rule is about our pages. Don't put our CSP on these pages: without a
`script-src` the script is blocked and the user is stuck on a blank page (`<noscript>` doesn't
render when JS is merely blocked by CSP).

## Constraints

- Follow the existing code style (see the repo's TypeScript conventions; Prettier width 100).
- All user-supplied or config-supplied text in HTML goes through `escapeHtml`.
- Styles are inline `<style>` blocks, because the CSP only allows inline styles and there is no
  static file route. That's intentional; don't add one.

## Provider: what was decided

Visual direction "C", the Interledger test wallet feel (colors read from the test wallet's CSS):

- Page background: diagonal gradient `#d8eeec` -> `#a0d5d5` -> `#36b3b0`.
- Centered white card, rounded (about 14px), soft shadow, near-black text `#040607`, secondary
  text a muted gray.
- Primary button: pink `#da35ba` with white text. Secondary button (logout "stay signed in"):
  white with a light gray border.
- Input border uses `#a0d5d5`. Errors: red border plus a red message under the field.
- Brand: a small square with a teal-to-pink gradient next to the text "Open Payments". Footer
  line "Powered by Open Payments". No logo files.
- System font stack. Wallet addresses in the input use a monospace stack.
- On narrow screens the card fills the width and the gradient shrinks to a band behind it.

Screens:

1. Sign-in. Heading "Welcome". Line "Sign in to <app> with your wallet address. You'll approve
   it at your wallet." Wallet address field (keep the current placeholder, autofocus and
   autocomplete attributes) and a "Continue" button.
2. Sign-in with an error. Same page, the existing error message under the field, the typed
   address kept (as today).
3. Logout confirmation, via `features.rpInitiatedLogout.logoutSource`. It must keep
   oidc-provider's form and its submit semantics (the `form` argument, `xsrf` field,
   `logout=yes` on the confirm button). In oidc-provider, both buttons sign the user out of
   the requesting app (its grant is revoked); the difference is only whether the provider
   session ends too. The copy has to be honest about that, so (my call, the mockup's "Stay
   signed in" label was misleading): heading "Sign out?", text along the lines of "<app> is
   signing you out. Also end your sign-in here? If you do, other apps will ask you to approve
   at your wallet again." Buttons "End my sign-in here" (primary, `logout=yes`) and "Only sign
   out of <app>" (secondary). When the app isn't known (no `client_id` or `id_token_hint`),
   the secondary button would do nothing in oidc-provider, so the page shows only the primary
   button and says to close the tab to stay signed in.
4. Signed out, via `features.rpInitiatedLogout.postLogoutSuccessSource`. Check icon, title,
   "You can close this tab." Only shown when the app gave no `post_logout_redirect_uri`. Two
   variants, told apart by whether `ctx.oidc.client` is set (oidc-provider forwards
   `client_id` only on the "only this app" path):
   - no client: "You're signed out".
   - client set: "You're signed out of <app>", plus a line saying you're still signed in here.
5. Generic error page, one template for every current use: expired login, not found, too many
   attempts, request too large, server errors, and oidc-provider's `renderError`. Icon, title,
   message.

The app name: show the client's optional `client_name` if set, otherwise its `client_id`.
`clients.json` gains an optional `client_name` field (non-empty string if present), validated
in `packages/oidc/src/clients.ts` like the other fields, documented in the README and added to
`config/clients.example.json`. oidc-provider already understands `client_name` as standard
client metadata. When the client isn't known (possible on the logout pages), the copy drops the
app name rather than showing a blank.

## Sample client: what was decided

Neutral, developer-tool look, clearly not the provider:

- Slate palette (`#0f172a` near-black, `#f8fafc` background, `#e2e8f0` borders), system font,
  monospace for values.
- A dark top bar with "Sample client" and two chips showing the issuer and client ID.
- Home, signed out: "Not signed in", one line describing what it is, the two existing sign-in
  actions as buttons ("Sign in with your wallet" and "Sign in, approving at the wallet again"),
  same URLs as today.
- Home, signed in: "Signed in as <sub>" and a Log out button.
- Callback result page: wallet address with a Log out button; green pills for what was verified
  (signature, issuer, audience, nonce, expiry); ID token claims as a key/value table, with
  `exp`, `iat` and `auth_time` also shown as readable UTC times; ID token header, userinfo and
  the raw ID token in collapsed `<details>` sections (no JS).
- Error pages (login failed, unknown state, 404, 405, 500) use the same frame with the message
  in red.
- Keep the current split: token details appear only on the callback page, home only says who's
  signed in. No behavior change.

## Tests

Existing tests match on page copy (for example `test/http/views.test.ts` and
`test/examples/sample-client.test.ts` look for "Sign in with your wallet address", "Signed in",
"Not signed in", the logout form's action and `xsrf`). Update them to the new copy where it
changes; don't weaken what they check (escaping, the form posting to the right URL, the claims
and userinfo appearing, logout working end to end). Add tests for the new parts: the logout
and signed-out pages (both variants) render through our templates, `client_name` parsing and validation, and
the app name appearing (escaped) on the sign-in page.

## Calls made by me, not the user

- Dropping React entirely and keeping template-string rendering in `packages/oidc/src/views.ts`.
- `client_name` support in `clients.json`.
- Text wordmark instead of the logo; system fonts; light only.
- The sample client's claims table, readable times, and the added raw ID token section.
- Same security headers on the oidc-provider-rendered pages (logout, signed out,
  `renderError`) as on our own pages, as far as oidc-provider lets us set them on `ctx`. Not on
  the auto-submit pages (see above).
- Logout confirmation button labels and the two signed-out variants, replacing the mockup's
  "Stay signed in".
- Leaving oidc-provider's auto-submit pages unstyled and out of scope.

## Left to the builder

- Exact spacing, sizes, shadows, and the secondary text grays.
- How to structure the shared page shell and CSS in `views.ts` (and whether the sample client
  keeps its own copy, since it isn't part of the service and the image doesn't ship it).
- How the sign-in handler looks up the client for its name.
- Exact wording of the logout and signed-out copy, within the intent above.
