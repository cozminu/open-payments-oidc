# Open Payments OIDC

[![CI](https://github.com/cozminu/open-payments-oidc/actions/workflows/ci.yml/badge.svg)](https://github.com/cozminu/open-payments-oidc/actions/workflows/ci.yml)

> **Experimental.** This hasn't had a security review, and by default it only accepts the
> Interledger test wallet. Read [Known limits](#known-limits) before putting it in front of real
> users. To report a vulnerability, see [SECURITY.md](SECURITY.md).

A self-hosted OpenID Connect provider where users sign in with an Open Payments wallet address
instead of a password. The user types their wallet address (`https://ilp.interledger-test.dev/alice`
or `$ilp.interledger-test.dev/alice`), the provider asks that wallet's authorization server to
verify the user with an interactive Open Payments subject grant, and the user approves at their
wallet. Apps get a normal OIDC authorization code flow and an ID token.

- ID token claims: `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce` (if sent) and
  `wallet_address`. `sub` is the canonical wallet address URL. No email, no profile.
- Only the authorization code flow (PKCE required for public clients).
- Wallet addresses can be on any host. What is restricted is the wallet's authorization server,
  by an origin allowlist (default: the Interledger test wallet). There is no "allow any" mode.
- State lives in Postgres, so restarts and several replicas work.
- Node 24 runs the TypeScript sources directly; there is no build step.

## Quick start (docker compose)

```sh
cp .env.example .env                       # then edit it, see the table below
cp config/clients.example.json config/clients.json
npm ci && npm run -s generate-jwks > config/jwks.json
openssl genpkey -algorithm ed25519 -out config/op-private-key.pem   # or see "Testnet setup"
docker compose up -d --build
curl -sf localhost:3000/healthz            # ok
```

`./config` is mounted read-only at `/config`. The files read from it are `clients.json`,
`jwks.json` and the provider's Open Payments private key (`op-private-key.pem` by default, set by
`OP_PRIVATE_KEY_PATH`). The container runs as the `node` user (uid 1000), so on Linux make sure
that user can read the files (for example `chmod 644`, or `chown 1000`). All of these are
gitignored; only `config/clients.example.json` is committed.

Without Node on the host you can generate the JWKS with the image instead:
`docker compose run --rm --no-deps oidc node src/cli/generate-jwks.ts > config/jwks.json`.

To run without compose: `npm ci --omit=dev`, set the environment, then `npm start`
(`node src/main.ts`, Node 24 or later).

Tagged releases are also published as a prebuilt image for amd64 and arm64,
`ghcr.io/cozminu/open-payments-oidc:<version>`. To use it with compose, replace `build: .` with
that image.

## Configuration

All settings are environment variables. `main` reports every missing or invalid variable at once
and exits non-zero. `.env.example` has the same list with comments.

| Variable                | Default                             | Meaning                                                                                                                                                                          |
| ----------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ISSUER`                | required                            | Public URL of the provider. Must be a root URL: http(s), no path, query or fragment. A trailing slash is stripped. Changing it invalidates tokens and sessions.                  |
| `DATABASE_URL`          | required                            | Postgres connection string. Compose builds it from `POSTGRES_PASSWORD`.                                                                                                          |
| `OP_WALLET_ADDRESS`     | required                            | The provider's own wallet address, used to sign grant requests.                                                                                                                  |
| `OP_KEY_ID`             | required                            | Id of the developer key registered on that wallet address.                                                                                                                       |
| `OP_PRIVATE_KEY_PATH`   | required                            | Path of the Ed25519 private key (PEM) for `OP_KEY_ID`. In compose, `/config/op-private-key.pem`.                                                                                 |
| `COOKIE_KEYS`           | required                            | Comma-separated cookie signing secrets. The first signs, all verify.                                                                                                             |
| `PORT`                  | `3000`                              | Listen port.                                                                                                                                                                     |
| `CLIENTS_FILE`          | `/config/clients.json`              | Registered clients.                                                                                                                                                              |
| `JWKS_FILE`             | `/config/jwks.json`                 | ID token signing keys (private JWKS).                                                                                                                                            |
| `SESSION_TTL_SECONDS`   | `3600`                              | Lifetime of the provider session and grant. While it lasts, a user who verified recently signs in to other apps without approving at the wallet again.                           |
| `AUTH_SERVER_ALLOWLIST` | `https://auth.interledger-test.dev` | Comma-separated origins of wallet authorization servers users may log in through. Origins only (no path); `*` and an empty list are errors. http origins need `ALLOW_HTTP=true`. |
| `ALLOW_HTTP`            | `false`                             | Allow http wallet addresses and auth servers and skip the private-address check. The SDK then sends every outbound request over plain http. Local development only.              |
| `TRUST_PROXY`           | `true`                              | Trust `X-Forwarded-For` and `X-Forwarded-Proto`. See Deployment notes.                                                                                                           |
| `RATE_LIMIT_PER_MINUTE` | `20`                                | Login submissions and wallet callbacks per client IP per minute, per replica.                                                                                                    |
| `OUTBOUND_TIMEOUT_MS`   | `5000`                              | Timeout for outbound Open Payments requests.                                                                                                                                     |

Compose-only: `POSTGRES_PASSWORD` (required, URL-safe characters), `CONFIG_DIR` (default
`./config`), `ENV_FILE` (default `.env`). Compose itself interpolates `PORT`, `POSTGRES_PASSWORD`,
`CONFIG_DIR` and `ENV_FILE` in `docker-compose.yml` from the shell environment or the
project-level `.env`, not from a custom `ENV_FILE`. If you point `ENV_FILE` elsewhere, also pass
that file with `docker compose --env-file <file>` (or export those variables).

## Clients file

`CLIENTS_FILE` is a JSON array; see `config/clients.example.json`. Changes need a restart.

| Field                        | Required                 | Meaning                                                                                                              |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `client_id`                  | yes                      | Unique id.                                                                                                           |
| `client_name`                | no                       | Shown to users on the sign-in and logout pages. Default: the `client_id`.                                            |
| `client_secret`              | for confidential clients | Used with `client_secret_basic` (default) or `client_secret_post`.                                                   |
| `token_endpoint_auth_method` | no                       | `client_secret_basic` (default), `client_secret_post` or `none`. Use `none` for public clients, which must use PKCE. |
| `redirect_uris`              | yes                      | Exact match only. https, or http for `localhost` and `127.0.0.1`.                                                    |
| `post_logout_redirect_uris`  | no                       | Allowed targets after RP-initiated logout. Same rules.                                                               |

Endpoints are the usual `oidc-provider` ones: discovery at `/.well-known/openid-configuration`,
`/auth`, `/token`, `/me` (userinfo), `/jwks`, `/session/end`. Health: `/healthz` (process up) and
`/readyz` (database reachable).

## Keys

ID token signing keys are a private JWKS file. Generate one:

```sh
npm run -s generate-jwks > config/jwks.json         # one RSA 2048 key, RS256
npm run -s generate-jwks -- --ec > config/jwks.json # RSA plus a P-256 key (ES256)
```

Clients get RS256 ID tokens (there is no per-client setting for another algorithm), so the file
needs at least one RSA key. The P-256 key from `--ec` is only published at `/jwks` and isn't used
to sign ID tokens for any registered client. The first key in the file signs; every key in the
file is published at `/jwks` for verification (an end-to-end test pins this).

Rotation:

1. Generate a new JWKS and put the new key first in `jwks.json`.
2. Keep the old keys after it until every token signed with them has expired. ID tokens last 5
   minutes, so a day is plenty, but keep them longer if clients cache the JWKS for longer.
3. Restart. Later, remove the old keys and restart again.

`COOKIE_KEYS` rotates the same way: prepend the new secret, keep the old one until sessions
signed with it have expired (`SESSION_TTL_SECONDS`), then drop it.

## Testnet setup

The provider is an Open Payments client and signs its grant requests, so it needs its own wallet
address and a key registered on it.

1. Create an account at the Interledger test wallet and note your wallet address (this becomes
   `OP_WALLET_ADDRESS`).
2. In the test wallet go to Settings > Developer Keys and create a key for that wallet address.
   Note the key id (`OP_KEY_ID`) and save the private key as `config/op-private-key.pem`. The
   file must be an Ed25519 key in PEM form (`-----BEGIN PRIVATE KEY-----`); if the wallet gives
   you a base64 blob instead, I believe decoding it (`base64 -d`) yields the PEM, but check.
3. Leave `AUTH_SERVER_ALLOWLIST` at its default, `https://auth.interledger-test.dev`.

Without a test wallet you can still start the service with a throwaway key (for example a freshly generated one); logins will fail at the wallet step.

## Run locally

This needs a browser and real testnet credentials (see Testnet setup), so it isn't part of the
automated tests.

1. Set up `.env`, starting from `.env.example`:
   - `ISSUER=http://localhost:3000` and `TRUST_PROXY=false`.
   - `OP_WALLET_ADDRESS` and `OP_KEY_ID` from your test wallet. The private key goes in
     `config/op-private-key.pem`.
   - `COOKIE_KEYS` and `POSTGRES_PASSWORD`, any random strings.
2. `cp config/clients.example.json config/clients.json`. It registers `example-spa`, a public
   client with redirect URI `http://localhost:5173/callback` and post-logout redirect URI
   `http://localhost:5173/`, which is what the sample client uses.
3. `npm ci && npm run -s generate-jwks > config/jwks.json`.
4. `docker compose up -d --build`, then `curl -sf localhost:3000/healthz` should print `ok`.
   After editing `.env`, run `docker compose up -d --force-recreate oidc` (a restart doesn't
   re-read it).
5. `npm run sample-client` and open <http://localhost:5173/>. Click Sign in, enter
   `$ilp.interledger-test.dev/<you>` and approve at the test wallet. You land back on the sample
   client, which has verified the ID token and shows its claims, its header and the userinfo
   response. `sub` and `wallet_address` should be your wallet address.

While the provider session lasts (`SESSION_TTL_SECONDS`) a second sign in skips the wallet. Use
"Sign in, approving at the wallet again" (`prompt=login`) to go through the wallet anyway.
"Log out" ends both the sample client's session and the provider's (RP-initiated logout): the
provider asks you to confirm, then sends you back to the sample client's home page.

The sample client takes `--issuer` (default `http://localhost:3000`), `--client-id` (default
`example-spa`) and `--port` (default `5173`). Its redirect URI is
`http://localhost:<port>/callback` and its post-logout redirect URI is
`http://localhost:<port>/`; both have to be registered for the client. It lives in
`examples/`, outside `src/`, so it isn't in the image.

If the sample client shows `server_error`, look at `docker compose logs oidc`. A
`grant request failed` with status 400 means the wallet's auth server rejected the provider's
own signed request: check `OP_WALLET_ADDRESS`, `OP_KEY_ID` and the private key belong together.

## Deployment notes

- TLS terminates at a reverse proxy in front of the service. The provider listens on plain http.
  Set `ISSUER` to the public https URL, at the root of a host (no path prefix).
- `TRUST_PROXY=true` (the default) makes the provider read `X-Forwarded-Proto` for secure
  cookies and `X-Forwarded-For` for rate limiting. Only use it behind a proxy that sets those. If
  clients can reach the service directly, set `TRUST_PROXY=false`, otherwise anyone can pick
  their own rate limit key.
- The rate limiter keys on the last `X-Forwarded-For` entry, the one your proxy appended.
  Earlier entries are client-supplied and ignored. This assumes exactly one trusted proxy hop in
  front of the service that appends the peer address (the usual default); a proxy that overwrites
  the header works too. With more hops (a CDN in front of your proxy) every client behind the
  outer hop shares the inner hop's address, so the limit would apply to all of them together.
- Logs are JSON lines on stdout (database pool errors and OIDC server errors included), one object per event with `time`, `level` and `msg`. Warnings
  and errors also go to stdout, so filter on the `level` field, not the stream. Tokens, codes,
  secrets, nonces and keys are never logged.
- The service migrates the database on startup (guarded by an advisory lock, so replicas can
  start together) and deletes expired rows every 10 minutes. On SIGTERM or SIGINT it stops
  accepting connections, closes the database and exits.

## Known limits

- Rate limits are in memory, so they apply per replica. N replicas allow roughly N times the
  limit.
- No cap on the size of outbound responses (wallet address and auth server replies). Only
  timeouts apply.
- No email claim, no profile claims, and no other scopes than `openid`.
- SSRF: user-supplied wallet address hosts are resolved and refused if they point at non-public
  addresses, but two gaps remain. DNS rebinding (the name resolves to a public address for the
  check and a private one for the request) and HTTP redirects from a public wallet host are not
  mitigated, because the SDK does its own fetch and has no option to plug in a custom fetch or
  dispatcher. The real fix is a custom undici dispatcher with
  an IP-filtering `lookup`.
- Clients are static: adding one means editing the file and restarting.

## Development

```sh
npm ci
npm test            # node:test, database on PGlite, Open Payments faked in-process
npm run typecheck
npx prettier --check .
```

Tests don't need Postgres or network (the database is PGlite). `createPgDb` is only exercised
against real Postgres by running the stack, for example `docker compose up` (Postgres 17).

## License

Apache License 2.0. See [LICENSE](LICENSE).
