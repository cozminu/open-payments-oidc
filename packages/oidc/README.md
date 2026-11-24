# @open-payments-oidc/oidc

An OpenID Connect provider where users sign in by proving they control an Open Payments wallet
address, as a plain Node `(req, res)` handler you mount in your own server. Node 24 or newer,
Postgres only.

## Install

```sh
pnpm add @open-payments-oidc/oidc
```

## Usage

```ts
import { createOidcHandler } from "@open-payments-oidc/oidc";

const op = await createOidcHandler({
  issuer: "https://login.example",
  clients, // ClientConfig[], validated like the clients file
  jwks, // { keys: JsonWebKey[] }, validated like the JWKS file
  cookieKeys,
  sessionTtlSeconds: 3600,
  database: pool, // connection string, pg.Pool or Db
  wallet: { address, keyId, privateKey },
  authServerAllowlist,
  allowHttp: false,
  outboundTimeoutMs: 5000,
  rateLimitPerMinute: 20,
  trustProxy: false,
  cleanup: true,
  log,
});

server.on("request", op.handler); // or app.use(op.handler) at the root
await op.ready(); // true if the database answers, for your own readiness check
await op.close();
```

`createOidcHandler` rejects with every config problem at once. It runs this package's and
`wallet-login`'s migrations when it's created.

## Config

| Field                 | Default  | Meaning                                                                              |
| --------------------- | -------- | ------------------------------------------------------------------------------------ |
| `issuer`              | required | Root URL of the provider: no path, query or fragment.                                |
| `clients`             | required | Registered clients. Redirect URIs must be https (http only for localhost).           |
| `jwks`                | required | Private signing keys, at least one RSA key. Every key needs a unique `kid`.          |
| `cookieKeys`          | required | Keys for signing cookies, newest first. At least one.                                |
| `sessionTtlSeconds`   | `3600`   | Lifetime of a session and its grants.                                                |
| `database`            | required | Connection string (opened and closed by the handler), `Db` or `pg.Pool` (left open). |
| `wallet`              | required | The provider's own wallet `address`, `keyId` and Ed25519 `privateKey`.               |
| `authServerAllowlist` | required | Origins of the auth servers you have a key arrangement with. No `*`, not empty.      |
| `allowHttp`           | `false`  | Local development only: allows http auth servers.                                    |
| `outboundTimeoutMs`   | `5000`   | Timeout for each request to a wallet or auth server.                                 |
| `rateLimitPerMinute`  | `20`     | Login submissions and wallet callbacks per client IP. Per process.                   |
| `trustProxy`          | `false`  | Trust `X-Forwarded-For` for the client IP. Only behind a proxy that sets it.         |
| `cleanup`             | `true`   | Delete expired rows from both tables every 10 minutes.                               |
| `log`                 | silent   | A `Logger`; `createLogger()` writes JSON lines to stdout.                            |

`wallet.privateKey` is a `KeyObject` or PEM text, never a file path.

## Things to know

- Mount the handler at the host root, before any body-parsing middleware. The login form is read
  from the request stream; if a parser already consumed it, the user gets a 400 page and the
  handler logs `interaction.body_consumed`.
- Postgres only. There's no in-memory store for the provider's own state.
- `trustProxy` defaults to `false` here. Turn it on only behind a proxy that sets
  `X-Forwarded-For`, or every client looks like the proxy to the rate limiter.
- `rateLimitPerMinute` is per process. With several replicas the effective limit is higher.
- `/healthz` and `/readyz` aren't served; use `ready()` from your own routes.
- After `close()`, requests get a 503 page. `close()` is idempotent and leaves a passed-in `Db` or
  pool open.
