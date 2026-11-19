Draft, not posted. Target repo: interledger/open-payments-node (feature request template).

Title: [FEATURE REQUEST] Accept a custom fetch in createUnauthenticatedClient and createAuthenticatedClient

---

## Feature Request

**Describe the feature you'd like to request**

I'd like the client factories to take an optional `fetch` and use it for every HTTP request the SDK makes.

My use case is an OpenID Connect provider where people sign in with their wallet address. The user types an address, the server calls `walletAddress.get()` on it, and then calls `grant.request()` and `grant.continue()` on the auth server that address points to. So the server fetches URLs a stranger chose. Any server-side app that takes a wallet address from a form is in the same position.

That's an SSRF surface: someone can enter an address whose host resolves to `169.254.169.254` or `10.x` and get the server to call cloud metadata or internal services. Resolving the host and refusing private ranges before calling the SDK doesn't fully close it:

- DNS rebinding. The name resolves to a public IP when I check it and to a private IP when fetch looks it up again a moment later. The check and the connection use separate lookups, so the only check that holds is one made at connect time.
- Redirects. ky follows redirects by default, so a public wallet host can 302 to `http://10.0.0.5/`. My pre-check never sees the second URL.
- Response size and duration. The `responseLogger` afterResponse hook in `client/requests.ts` calls `response.clone().text()` on every response, whatever the log level, because the level check happens inside `logger.debug` after the body has been read. A hostile host can send a huge body and the SDK buffers all of it. From reading ky's `timeout()`, I think `requestTimeoutMs` only covers `fetch()` until the headers arrive, so a body sent slowly isn't bounded at all. I haven't reproduced that, it's from reading the code.

All three have to be handled where the connection is made. The SDK doesn't give callers access to that.

**Describe the solution you'd like**

Add `fetch?: typeof globalThis.fetch` to `CreateUnauthenticatedClientArgs`, which also gives it to `createAuthenticatedClient` through `BaseAuthenticatedClientArgs`. Pass it through `createUnauthenticatedDeps` and `createAuthenticatedClientDeps` into `createHttpClient`, then on to `ky.create()`. ky already supports a `fetch` option and falls back to `globalThis.fetch` when it's undefined, so nothing changes for existing callers.

```ts
// packages/open-payments/src/client/requests.ts
interface CreateHttpClientArgs {
  logger: Logger
  requestTimeoutMs: number
  requestSigningArgs?: AuthenticatedHttpClientArgs
  fetch?: typeof globalThis.fetch
}

const kyInstance = ky.create({
  timeout: requestTimeoutMs,
  fetch: args.fetch,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
})
```

Signing runs in a `beforeRequest` hook, and ky calls `fetch` after those hooks, so a custom fetch receives the request already signed. Signatures stay valid as long as the custom fetch doesn't change the method, URL, headers or body. That's worth a line in the option's doc comment.

With that in place, a Node caller could do:

```ts
import { Agent, fetch as undiciFetch } from 'undici'

const dispatcher = new Agent({
  // Called for every connection, including each redirect hop, after DNS resolution.
  connect: { lookup: publicAddressesOnly },
  bodyTimeout: 5000
})

const client = await createAuthenticatedClient({
  walletAddressUrl,
  keyId,
  privateKey,
  fetch: (input, init) => undiciFetch(input, { ...init, dispatcher, redirect: 'error' })
})
```

The same wrapper can also wrap `response.body` in a stream that counts bytes and errors past a limit. The logger hook's `text()` would then reject and the SDK call would fail, which is what I want.

Tests I'd add:
- `createUnauthenticatedClient({ fetch })` calls the custom fetch for `walletAddress.get()`.
- `createAuthenticatedClient({ fetch })` passes `grant.request()` to the custom fetch with `Signature` and `Signature-Input` already set.
- Without the option, the global fetch is still used (the existing tests probably cover this).

**Describe alternatives you've considered**

- `setGlobalDispatcher()` from undici. This is the workaround I'm planning, and it works because ky calls the global fetch. But it's process-wide, so every other `fetch` in the app goes through the same filter. It also depends on the SDK using the global fetch, which is an implementation detail rather than something the SDK promises, and it needs an `undici` package that's compatible with the version bundled in Node.
- A `dispatcher` option instead of `fetch`. That's Node and undici only. A `fetch` option works in any runtime, which I think fits #4 better.
- Patching the SDK locally. That works, but I'd rather not carry a patch.

**Additional context**

Separately, `responseLogger` could skip reading the body when `logger.isLevelEnabled('debug')` is false. Then responses wouldn't be buffered a second time when logging is off. I'm happy to split that into its own issue.

I can open a PR for the `fetch` option if you'd take one.
