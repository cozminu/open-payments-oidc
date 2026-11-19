Drafts of the GitHub issues for Phase 1 of ROADMAP.md (everything except the external security
review). Not posted yet. Each section below is one issue: title, labels, then the body. They're
written for an agent to pick up and implement without asking questions.

Order: #1 first. #2 and #3 build on the module #1 adds. #4 and #5 are independent.

Milestone for all five: "Phase 1".

---

# 1. SSRF: filter outbound connections by IP at connect time

Labels: enhancement

## Why

Users type a wallet address and the provider fetches it, so the provider makes requests to hosts
a stranger picked. `assertPublicHost` (`src/wallet/address.ts`) resolves the host and refuses
non-public addresses before the SDK fetches, but the SDK's fetch does its own DNS lookup a moment
later. A name that answers with a public IP for the check and a private one for the fetch (DNS
rebinding) gets through. The only check that holds is one made where the connection is opened.

The README says this can't be fixed because the SDK has no way to plug in a fetch or dispatcher.
That's only half true: `@interledger/open-payments` 7.4.0 uses `ky`, and `ky` calls
`globalThis.fetch` on every request (`options.fetch ?? globalThis.fetch.bind(globalThis)` in
`ky/distribution/core/Ky.js`). Node's global fetch uses undici's global dispatcher. So
`setGlobalDispatcher()` with an IP-filtering dispatcher covers every SDK request without touching
the SDK.

The proper fix is a `fetch` option in the SDK. A draft upstream issue for that is in
`docs/upstream/open-payments-node-custom-fetch.md` (not filed yet). This issue is the workaround
until then.

## What to build

- Add `undici` `^7` as a dependency. Node 24 (CI and the Docker image) bundles undici 7.x. A probe
  found that npm undici 7.30.2's `Agent`, with a `compose` interceptor using `onResponseStart` and
  `abort()`, works under the built-in fetch on both Node 24.18 (bundled 7.28.0) and Node 26.13
  (bundled 8.12.4). `setGlobalDispatcher` writes both global dispatcher symbols. Still run the
  tests on Node 24 and on a newer Node.
- Don't replace `globalThis.fetch` with undici's `fetch`. ky passes a built-in `Request` object to
  fetch, and `undici.fetch(<built-in Request>)` throws "Failed to parse URL". If you ever need
  undici's fetch, `undici.install()` swaps `Request`, `Response` and `Headers` along with it.
- New module `src/wallet/outbound.ts`:
  - `createOutboundDispatcher(opts)` returns an undici `Agent`. Options: `filterAddresses: boolean`
    and `lookup` (injectable for tests, defaults to `dns.lookup`). #2 and #3 add more options and
    compose interceptors onto this same dispatcher, so keep it easy to extend
    (`agent.compose(...)`).
  - When `filterAddresses` is true:
    - Give the connector a `lookup` that resolves with `all: true` and fails the connection if
      any resolved address is non-public. This is the same rule as `assertPublicHost`: refuse if
      any address is bad, not just the first.
    - Node's `net.connect` doesn't call `lookup` when the host is already an IP literal, so a
      lookup filter alone misses `https://10.0.0.5/`. Wrap the connector
      (`buildConnector(...)`) so it checks IP-literal hostnames before connecting.
    - Use a clear error message, for example `refused connection to non-public address`.
  - `installOutboundDispatcher(opts)` calls `setGlobalDispatcher(createOutboundDispatcher(opts))`.
- Move the IP ranges and `isNonPublic` out of `address.ts` (or export them) so both checks use one
  list.
- In `src/main.ts`, install the dispatcher before `createAuthenticatedClient`, with
  `filterAddresses: !config.allowHttp`. Install it unconditionally, so #2 and #3 apply with
  `ALLOW_HTTP=true` too. Only the address filter is off in that mode, the same as
  `assertPublicHost` today. Keep the previous global dispatcher. Restore it in `close()`, and in
  the startup-failure path too.
- Keep `assertPublicHost` in the verifier. It still gives users the friendlier "couldn't reach
  that wallet address" message before any request goes out. The dispatcher is what actually
  enforces the rule.

Behavior change to document: requests to allowlisted auth servers go through the filter too. An
auth server on a private network stops working unless `ALLOW_HTTP=true`. That's intended.

`oidc-provider` makes no outbound requests with static clients (no `jwks_uri` or
`sector_identifier_uri` in `src/config/clients.ts`), so the process-wide dispatcher only affects
Open Payments calls today.

## Tests

The global dispatcher is process-wide. `node --test` runs each test file in its own process, so
any test that calls `installOutboundDispatcher` should live in its own file, and should restore
the previous dispatcher (`getGlobalDispatcher()`) in `after()`. For everything else, pass the
dispatcher per request: `fetch(url, { dispatcher })`. Don't install it in `test/support/test-app.ts`.
The `CookieJar` there uses global fetch against the provider and expects 303s, which #2 would
refuse.

- The filtering lookup: public addresses pass; any non-public address in the result fails,
  including when it's mixed in with public ones; IPv4-mapped IPv6 fails.
- Rebinding: an injected `lookup` resolves `wallet.test` to `127.0.0.1`, and the fake Open Payments
  server listens there. With `filterAddresses: true`, a fetch through the dispatcher is refused
  even though a pre-check stubbed to pass said the host was fine.
- An IP literal (`http://127.0.0.1:<port>/`) is refused with `filterAddresses: true` and allowed
  with `false`.
- Through the SDK, in its own file: install the dispatcher, call `walletAddress.get()` on a fake
  whose host resolves to loopback, and expect it to reject. The fake is in
  `test/support/fake-open-payments.ts`.
- The test-app based tests run with `allowHttp: true` against fakes on 127.0.0.1 and don't go
  through `main()`, so they're unaffected. `test/main.test.ts` is the exception. Its third test
  calls `main()` without `ALLOW_HTTP` and then uses global fetch to reach
  `http://127.0.0.1:<port>/healthz`, `/readyz` and discovery. The filter would refuse those. Set
  `ALLOW_HTTP: "true"` in that test, since it's about startup and not SSRF. Add a test that
  `close()` restores the previous global dispatcher.
- ky retries GET (and DELETE) up to 2 times, with 300ms then 600ms backoff, and a dispatcher abort
  counts as a retryable error. So a refused `walletAddress.get()` can hit the server 3 times.
  Assert that the call is refused and that nothing reached the forbidden target. Don't assert
  exact hit counts on the fake.

## Docs

- README Known limits: rewrite the SSRF bullet. DNS rebinding is covered. Mention that it relies
  on the SDK using global fetch, and link the upstream draft. Redirects stay listed until #2 lands.
- README env table, `ALLOW_HTTP`: it also turns off the connect-time filter.

## Done when

A wallet address whose name resolves to a non-public address at connect time is refused, even if
an earlier lookup returned a public address, and the tests above pass on Node 24.

---

# 2. SSRF: refuse HTTP redirects on outbound requests

Labels: enhancement
Depends on: #1

## Why

`ky` leaves fetch on `redirect: 'follow'`, so a public wallet host can answer with a 302 to an
internal URL. Once #1 is in, each hop's IP gets checked at connect time. Without this issue,
though, a redirect could still take an auth server request (which carries our signed request and
the continue token) off the allowlisted origin.

Legitimate wallets don't redirect API clients. A wallet address server only redirects when the
request comes from a browser (`Accept: text/html`), and the SDK always sends
`Accept: application/json`. So refusing every redirect breaks nothing real.

## What to build

- Add an interceptor to the dispatcher from #1, composed onto the `Agent`, that fails any
  response with a 3xx status. Use the undici 7 handler API (`onResponseStart`) and abort with a
  clear error such as `refused redirect from <origin>`. Fetch's redirect handling runs above the
  dispatcher and only sees the 3xx after the dispatcher hands it up, so failing here means fetch
  never follows it.
- On whenever the dispatcher is installed, including `ALLOW_HTTP=true`.
- No config option.

## Tests

- Unit: a server that answers 301, 302, 303, 307 and 308. A fetch through the dispatcher rejects
  for each, and nothing reaches the redirect target. Have the target be a second server that
  records hits. Through the SDK, ky retries refused GETs (see #1), so the redirecting server may
  see up to 3 hits. The target must still see 0.
- Through the verifier, in a file that installs the dispatcher globally (see the test notes in
  #1): add an option to the fake to redirect the wallet address GET, and another to redirect the
  grant request. `WalletVerifier.start()` returns `invalid_input` for the first and `failed` for
  the second, and the redirect target is never hit.
- The existing suite still passes.

## Docs

README Known limits: take redirects out of the SSRF bullet.

## Done when

No outbound Open Payments request follows a redirect, whatever the config.

---

# 3. Cap outbound response size and total request time

Labels: enhancement
Depends on: #1

## Why

There's no limit on how big a wallet address or auth server reply can be. The SDK's
`responseLogger` hook runs `response.clone().text()` on every response, even with
`logLevel: "silent"`, because the level check happens inside `logger.debug` after the body has
been read. So the SDK buffers the whole body before our code sees anything, and any cap has to be
applied below the SDK, in the dispatcher.

Time isn't bounded either. ky's `timeout` (our `OUTBOUND_TIMEOUT_MS`) wraps `fetch()` only until
it resolves, which is when the headers arrive (`ky/distribution/utils/timeout.js`). The body is
read after that with no timeout, so a server that sends the body a byte at a time can hold a login
open indefinitely. undici's `bodyTimeout` doesn't fix this on its own, since it resets on every
chunk. I got this from reading the code and haven't reproduced it; write that test first.

Two more things make this harder than it looks. A probe during review confirmed both:

- Compression. Node's fetch sends `accept-encoding: gzip, deflate` and decompresses above the
  dispatcher, so the dispatcher only sees wire bytes. 4,895 bytes of gzip turned into 5,000,000
  bytes from `r.text()`. A cap that counts wire bytes doesn't bound memory.
- Retries. ky retries GET and DELETE up to 2 times (300ms, then 600ms backoff), and a dispatcher
  abort counts as retryable. The `afterResponse` hook runs inside the retry loop, so an abort
  mid-body is retried too. A per-request deadline therefore bounds each attempt, but not the
  whole `walletAddress.get()` call: that's about 3x the timeout plus 0.9s. The SDK exposes no
  option for retries or an abort signal. Grant POSTs aren't retried.

## What to build

- New env var `OUTBOUND_MAX_RESPONSE_BYTES`: an integer, default `65536`, between `1024` and
  `10485760`. Parse it with the existing `integer()` helper in `src/config/env.ts` and add it to
  `Config`.
- Add an interceptor to the dispatcher from #1, composed alongside #2's:
  - If `Content-Length` is over the limit, fail at `onResponseStart`.
  - Count body bytes in `onResponseData` and abort once the total goes over the limit.
    This matters for chunked responses or ones that lie about their length.
  - Set the outgoing `accept-encoding` header to `identity`, and fail any response whose
    `content-encoding` is anything other than absent or `identity`. Then the bytes counted are
    the bytes that get buffered.
  - Set a deadline of `OUTBOUND_TIMEOUT_MS` from dispatch until the body is complete, and abort
    when it expires. This bounds each attempt, body included.
- Bound the whole call as well, in `WalletVerifier`. Wrap each SDK call (`walletAddress.get`,
  `grant.request`, `grant.continue`, `token.revoke`) in a helper that rejects after
  `OUTBOUND_TIMEOUT_MS`, and map that rejection to the same outcome the call's other failures
  already get. The user then waits at most `OUTBOUND_TIMEOUT_MS` per step, whatever ky does with
  retries. A retry ky starts in the background after we give up still has its per-attempt
  deadline, so it can't run forever. That's ugly but acceptable until the SDK takes a signal.
  Pass the timeout into `WalletVerifierOptions`.
- Pass the values into `installOutboundDispatcher` from `main.ts`. They're on with
  `ALLOW_HTTP=true` as well.
- Check that an abort mid-body surfaces through the SDK as a rejected call. The `clone().text()`
  in the logger hook should reject, ky should cancel the response, and the verifier should map it
  to its existing outcomes. Nothing should hang or leak an unhandled rejection.

## Tests

- Write the slow-body test first, against the current code, to confirm the hang: a fake that
  sends headers, then one byte per second. Then make it pass with the deadline.
- `Content-Length` over the limit is rejected before any body is read.
- A chunked body with no `Content-Length` is rejected once it goes over the limit.
- A response exactly at the limit passes.
- Gzip bomb: a server that sends a small gzip body, which decodes to well over the limit, with
  `content-encoding: gzip` regardless of the request. It's rejected. Also check that the request
  that went out had `accept-encoding: identity`.
- Retries: a slow-body fake behind `walletAddress.get()`. `WalletVerifier.start()` returns within
  `OUTBOUND_TIMEOUT_MS` plus a small margin, even though ky retries in the background. Use a
  short timeout in the test.
- Through the verifier, with the dispatcher installed globally in its own file: an oversized
  wallet address response returns `invalid_input`, and an oversized grant response returns
  `failed`.
- Env parsing: default, valid value, out of range, not an integer.

## Docs

- README env table and `.env.example`: add `OUTBOUND_MAX_RESPONSE_BYTES`, and say it counts
  uncompressed bytes (the provider asks for no compression). Reword `OUTBOUND_TIMEOUT_MS`: it's
  the longest the provider waits on any one outbound step, body included.
- README Known limits: remove the response size bullet.

## Done when

An outbound response bigger than the limit fails the login cleanly, compressed or not. No login
step waits more than `OUTBOUND_TIMEOUT_MS` on an outbound call, including when a body is still
streaming or ky is retrying.

---

# 4. Shared rate limits in Postgres

Labels: enhancement

## Why

`RateLimiter` (`src/http/rate-limit.ts`) keeps its counters in memory, so the limit applies per
replica: N replicas allow about N times `RATE_LIMIT_PER_MINUTE`. All other state already lives in
Postgres, so the limit should too.

## What to build

- Migration version 2 in `src/db/migrate.ts`, one statement per entry, because PGlite rejects
  multi-statement strings:
  - `CREATE TABLE rate_limits (key text NOT NULL, window_start timestamptz NOT NULL, count int NOT NULL, PRIMARY KEY (key, window_start))`
  - `CREATE INDEX rate_limits_window_start ON rate_limits (window_start)`
- Replace the in-memory class with a Postgres one, keeping the `clientIp` helper as is:
  - `allow(key): Promise<boolean>` runs one statement:
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, date_trunc('minute', now()), 1) ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`.
    It's allowed while `count <= limitPerMinute`.
  - Windows are fixed calendar minutes, timed by the database clock. The current code starts a
    window at a key's first hit. The change means a burst that straddles a minute boundary can get
    up to twice the limit. That's acceptable. Note it in the code comment.
  - Don't store raw IPs. The key is an HMAC-SHA256 of the IP, using the first `COOKIE_KEYS` entry
    as the HMAC key, hex encoded. Every replica shares that key, so they produce the same hash.
    A plain SHA-256 wouldn't help, because the IPv4 space is small enough to brute-force. If the
    cookie key rotates, counts reset for a minute, which is fine.
  - Keep the `limitPerMinute` validation from the current constructor.
- Remove the in-memory implementation. Nothing else needs it once tests use PGlite.
- `src/http/app.ts`: `isRateLimited` becomes async, and the two call sites `await` it. It still
  runs before any body read or wallet work. If the database query throws, log
  `rate_limit.failed` with the error message only and answer 503 using the existing error page.
  In other words, fail closed. A login can't work without the database anyway.
- `src/db/cleanup.ts`: `deleteExpired` also runs
  `DELETE FROM rate_limits WHERE window_start < date_trunc('minute', now())` and returns a
  `rateLimits` count. Its log line (`cleanup.done`) picks the count up automatically.
- `src/main.ts` and `test/support/test-app.ts`: build the new limiter with the app's `db`.

## Tests

The tests use PGlite (`test/support/db.ts`), so no real Postgres is needed.

- Allows up to the limit, then blocks.
- Separate keys count separately.
- Two limiter instances on the same database share one count. Use the cross-replica pattern in
  `test/e2e/login.test.ts` ("cross-replica") for an end-to-end version: two app instances, one
  database, and the combined requests go over the limit.
- A new window: insert a row with an old `window_start` directly, then check it doesn't count.
  Don't try to move the database clock.
- No raw IP in the table: after a request, `rate_limits.key` doesn't contain the client IP.
- Database error: a limiter whose query throws gives a 503 and a `rate_limit.failed` log line.
- Cleanup deletes old windows and keeps the current one.
- Migration test (`test/db/migrate.test.ts`): version 2 applies, and running it twice is a no-op.
- Move the current tests in `test/http/rate-limit.test.ts` to the new class where they still
  apply. Keep the `clientIp` tests unchanged.

## Docs

- README Known limits: remove the per-replica bullet.
- README env table and `.env.example`: change `RATE_LIMIT_PER_MINUTE` from "per replica" to
  shared across replicas.

## Done when

With two replicas on one database, a client IP gets `RATE_LIMIT_PER_MINUTE` login submissions
and callbacks per minute in total, not per replica.

---

# 5. Find out which production wallets support interactive subject grants

Labels: documentation

## Why

Today the only supported auth server is the Interledger test wallet
(`AUTH_SERVER_ALLOWLIST` defaults to `https://auth.interledger-test.dev`). Before strangers can
sign in with real wallets, we need to know which production Open Payments wallets accept what
`WalletVerifier.start()` sends (`src/wallet/verifier.ts`): a grant request with
`subject.sub_ids` (format `uri`) and `interact.start: ["redirect"]`, and a continuation that
returns the verified `subject`.

This is research, not code. Some of it depends on other people's wallets and may turn into
upstream work, for example on Rafiki.

## What to do

- List the production wallets that run Open Payments. Start from the Interledger docs and
  website and Rafiki's list of deployments. For each, find:
  - the auth server origin: fetch a public wallet address with
    `Accept: application/json` and read `authServer`
  - whether it runs Rafiki, and which version, if that's public
  - whether it supports subject grants, with evidence. Check what the Open Payments spec says
    about `subject` in grant requests. If it runs Rafiki, check the Rafiki auth service source
    for where it handles `subject` and since which release. Check any of the wallet's own docs.
- Don't send signed grant requests to production auth servers. Unauthenticated wallet address
  GETs are fine.
- Some things need a real account at the wallet, such as approving a login end to end. Don't
  try those. List them as steps for me, with what to look for.
- Where support is missing in Rafiki itself, draft an upstream issue in the style of
  `docs/upstream/open-payments-node-custom-fetch.md` and save it under `docs/upstream/`. Don't
  file anything.

## Output

`docs/wallet-support.md` with:

- a table: wallet, auth server origin, Rafiki or not (and version), subject grant support
  (yes, no or unknown), evidence link
- the manual test steps for me
- which origins look safe to add to `AUTH_SERVER_ALLOWLIST` examples in the README, if any
- the upstream drafts it links to

## Done when

The document exists and each wallet's answer comes with a source or is marked unknown. Opinions
don't count as answers.
