# Open Payments OIDC

An OpenID Connect provider where users sign in by proving control of an Open Payments wallet
address instead of a password.

## Language

**Wallet address**:
The URL that identifies a user's Open Payments account, and the user's whole identity here (`sub`).
_Avoid_: payment pointer (only an input shorthand), account

**Auth server**:
The Open Payments authorization server a wallet address names, which grants or refuses the login.
_Avoid_: authorization server, AS

**Auth server allowlist**:
The origins of auth servers users may sign in through. Wallet addresses themselves can be on any host.

**Outbound policy**:
The rule for which hosts the provider may contact, and over which scheme: wallet addresses on
public hosts only, credentials only to allowlisted auth server origins, browsers only to safe
redirects.
_Avoid_: SSRF filter, egress rules

**Open Payments gateway**:
What makes every request the provider sends to wallet addresses and auth servers, and refuses any
the outbound policy doesn't allow.
_Avoid_: SDK wrapper, client
