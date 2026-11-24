# @open-payments-oidc/wallet-login

Proves a user controls an Open Payments wallet address, using an interactive subject grant. You run
your own sessions; this handles the wallet step. Node 24 or newer.

## Install

```sh
pnpm add @open-payments-oidc/wallet-login
```

## Usage

```ts
import { createWalletLogin, postgresStore } from "@open-payments-oidc/wallet-login";

const login = await createWalletLogin({
  wallet: { address: "https://wallet.example/provider", keyId: "my-key", privateKey }, // KeyObject or PEM text
  authServerAllowlist: ["https://auth.interledger-test.dev"],
  store: await postgresStore({ database: process.env.DATABASE_URL! }), // or memoryStore()
});

const started = await login.start(rawWalletAddress, "https://app.example/wallet-callback");
// started: { kind: "redirect", loginId, redirectUrl } | { kind: "invalid_input", message }
//        | { kind: "failed", reason }
// Keep started.loginId in the user's session, then redirect the browser to redirectUrl.

const finished = await login.finish(loginIdFromSession, callbackQuery); // URLSearchParams is fine
// finished: { kind: "verified", walletAddress } | { kind: "denied", reason } | { kind: "failed", reason }

await login.close();
```

`start` and `finish` never throw. `createWalletLogin` rejects with every config problem at once.
`postgresStore` runs this package's migration when it's created.

## Config

| Field                 | Default    | Meaning                                                                    |
| --------------------- | ---------- | -------------------------------------------------------------------------- |
| `wallet.address`      | required   | Your own wallet address, which auth servers know your key by.              |
| `wallet.keyId`        | required   | Id of your key at that wallet.                                             |
| `wallet.privateKey`   | required   | Ed25519 `KeyObject` or PEM text. A file path is an error, nothing is read. |
| `authServerAllowlist` | required   | Origins of the auth servers you'll talk to. No `"*"`, at least one.        |
| `allowHttp`           | `false`    | Local development only: allows http and skips the public-host check.       |
| `outboundTimeoutMs`   | `5000`     | Timeout per request to a wallet or auth server, 1 to 600000.               |
| `loginTtlSeconds`     | `600`      | How long a user has between `start` and `finish`.                          |
| `store`               | required   | A `PendingLoginStore`: `memoryStore()` or `postgresStore({ database })`.   |
| `log`                 | no logging | A `Logger` (`createLogger()` writes JSON lines). Secrets are never logged. |

## Security

Keep `loginId` in the user's own session (a cookie) and never put it in the callback URL. Tying it
to the browser is what stops login CSRF: otherwise an attacker could send someone their own
finished callback URL and log them in as the attacker's wallet.

`memoryStore` is for a single process only; entries are lost on restart and not shared between
replicas. Use `postgresStore` with more than one instance.

A custom `PendingLoginStore` must make `take` atomic (one caller wins across replicas) and keep
`PendingLogin` out of logs, since it holds a grant continuation token.
