# @open-payments-oidc/server

`startServer` runs the Open Payments OIDC provider on its own HTTP server, with `/healthz` and
`/readyz`. It's also the `open-payments-oidc` command the Docker image runs. Node 24 or later.

```sh
npm install @open-payments-oidc/server
```

It re-exports everything from [`@open-payments-oidc/oidc`](../oidc/README.md).

## startServer

```ts
import { startServer } from "@open-payments-oidc/server";

const running = await startServer({
  issuer: "https://id.example.com",
  clients, // ClientConfig[]
  jwks, // { keys: JsonWebKey[] }, private signing keys
  cookieKeys: ["a-long-random-secret"],
  database: process.env.DATABASE_URL, // connection string, pg.Pool or Db
  wallet: { address, keyId, privateKey },
  authServerAllowlist: ["https://auth.interledger-test.dev"],
  port: 3000,
  host: undefined,
});

running.address; // AddressInfo
await running.close();
```

It takes everything `createOidcHandler` takes (see the `oidc` README), plus:

| Option | Default     | Meaning                                  |
| ------ | ----------- | ---------------------------------------- |
| `port` | `3000`      | Port to listen on. `0` picks a free one. |
| `host` | all of them | Interface to bind.                       |

It serves `/healthz` (process up) and `/readyz` (database reachable) and sends everything else
to the handler. `close()` is idempotent: it stops accepting connections (forcing stuck ones shut
after 8 seconds), then closes the handler. A database you passed in as a `Db` or `pg.Pool` stays
open. It installs no signal handlers and never calls `process.exit`; that's up to your app.

It logs only if you pass a `log`.

## Command line

| Command                            | What it does                                                          |
| ---------------------------------- | --------------------------------------------------------------------- |
| `open-payments-oidc`               | Starts the server from environment variables and the files they name. |
| `open-payments-oidc-generate-jwks` | Prints a private JWKS (`--ec` adds a P-256 key).                      |

The environment variables, defaults and files are listed in the
[main README](../../README.md#configuration).
