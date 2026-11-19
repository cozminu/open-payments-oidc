# Roadmap

No dates. I work on this at my own pace. Each phase ends at a point where the project makes
sense on its own, so stopping after any phase is fine. Every phase gets its own design pass
when it starts.

## Phase 1: safe for real users

- Close the SSRF gaps listed under Known limits in the README: a custom undici dispatcher that
  filters IPs at connect time (covers DNS rebinding), and HTTP redirects refused or re-checked.
- Cap the size of outbound responses (wallet address and auth server replies).
- Shared rate limits, stored in Postgres, so the limit holds across replicas.
- Real wallets beyond the Interledger test wallet. First step is finding out which production
  wallets support interactive subject grants. This depends on other people's wallets, so it may
  turn into upstream work (for example on Rafiki) or wait on it.
- An external security review. The "Experimental" warning comes off after that.

Done when: I'd let strangers sign in to an app through it.

## Phase 2: reference quality

- The UI redesign (`docs/superpowers/specs/2026-11-19-ui-redesign-design.md`). It's already
  specced, so it can go before Phase 1 work if that's convenient.
- Pass the OpenID conformance suite for the flows we support, then get certified.
- Docs an outsider can deploy from without asking me anything.
- Get it in front of the Interledger community.

Done when: someone else deploys it and it works.

## Phase 3: self-host polish

- Managing clients without a restart: an admin CLI, dynamic client registration, or both.
- Metrics (Prometheus).
- Upgrade, backup and restore docs.
- Maybe a Helm chart.

Done when: running it for months is boring.

## Not now

- A hosted service (multi-tenant, self-serve signup, dashboard). It's a different kind of
  project and isn't planned.
- Email and profile claims, and scopes other than `openid`. The wallet address is the whole
  identity; more claims would mean storing user data, and that's a decision for later.
