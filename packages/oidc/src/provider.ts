import type { JsonWebKey } from "node:crypto";
import Provider from "oidc-provider";
import type { ClientMetadata, JWKS } from "oidc-provider";
import type { ClientConfig } from "./clients.ts";
import type { Db, Logger } from "@open-payments-oidc/wallet-login";
import { createAdapterFactory } from "./oidc-adapter.ts";
import {
  appNameOf,
  renderErrorPage,
  renderLogoutPage,
  renderSignedOutPage,
  SECURITY_HEADERS,
} from "./views.ts";

export type ProviderSettings = {
  issuer: string;
  cookieKeys: string[];
  sessionTtlSeconds: number;
  trustProxy: boolean;
};

export type OidcProviderDeps = {
  settings: ProviderSettings;
  clients: ClientConfig[];
  jwks: { keys: JsonWebKey[] };
  db: Db;
  /** Where protocol and server errors are logged. Default: not logged. */
  log?: Logger;
};

export function createOidcProvider({
  settings,
  clients,
  jwks,
  db,
  log,
}: OidcProviderDeps): Provider {
  const provider = new Provider(settings.issuer, {
    adapter: createAdapterFactory(db),
    clients: clients as ClientMetadata[],
    // oidc-provider's defaults, plus auth_time in every ID token so apps can check login age.
    clientDefaults: {
      grant_types: ["authorization_code"],
      id_token_signed_response_alg: "RS256",
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      require_auth_time: true,
    },
    jwks: jwks as JWKS,
    cookies: { keys: settings.cookieKeys },
    responseTypes: ["code"],
    scopes: ["openid"],
    // Only sub and wallet_address, ever. No email, profile or anything else.
    claims: { openid: ["sub", "wallet_address"] },
    // With the default (true), code-flow ID tokens would omit wallet_address, which would then
    // only be available from userinfo.
    conformIdTokenClaims: false,
    findAccount: async (_ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ sub, wallet_address: sub }),
    }),
    // Same lookup as the default, plus: a session that already has an account (a wallet was
    // verified in this session) gets an openid grant on the fly. All clients are first party, so
    // there is no consent screen. This does not touch the login prompt: prompt=login and max_age
    // are decided from the session before grants are loaded.
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ??
        ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId);
      if (grantId) {
        const existing = await ctx.oidc.provider.Grant.find(grantId);
        if (existing) return existing;
      }
      const accountId = ctx.oidc.session?.accountId;
      if (!accountId) return undefined;
      const grant = new ctx.oidc.provider.Grant({
        accountId,
        clientId: ctx.oidc.client!.clientId,
      });
      grant.addOIDCScope("openid");
      await grant.save();
      return grant;
    },
    renderError: async (ctx, out) => {
      setPageHeaders(ctx);
      ctx.type = "html";
      ctx.body = renderErrorPage(out.error_description ?? out.error);
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    ttl: {
      Session: settings.sessionTtlSeconds,
      Grant: settings.sessionTtlSeconds,
      Interaction: 900,
      AuthorizationCode: 60,
      IdToken: 300,
      // Only used for userinfo.
      AccessToken: 300,
    },
    features: {
      devInteractions: { enabled: false },
      // Not reached when there's no session: oidc-provider then auto-submits with its own page.
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) => {
          setPageHeaders(ctx);
          ctx.type = "html";
          ctx.body = renderLogoutPage({ form, appName: appNameOf(ctx.oidc.client) });
        },
        postLogoutSuccessSource: async (ctx) => {
          setPageHeaders(ctx);
          ctx.type = "html";
          ctx.body = renderSignedOutPage({ appName: appNameOf(ctx.oidc.client) });
        },
      },
      userinfo: { enabled: true },
      revocation: { enabled: false },
      introspection: { enabled: false },
    },
    enabledJWA: {
      idTokenSigningAlgValues: ["RS256", "ES256"],
    },
    pkce: {
      required: (_ctx, client) => client.clientAuthMethod === "none",
    },
  });
  provider.proxy = settings.trustProxy;
  if (log !== undefined) logProviderErrors(provider, log);
  return provider;
}

// Path and error message only: the request carries codes, tokens and client secrets, and
// oidc-provider's error descriptions can echo request values. Client mistakes are warnings.
function logProviderErrors(provider: Provider, log: Logger): void {
  provider.on("server_error", (ctx, error) => {
    log.error("oidc.server_error", { path: ctx.path, error: error.message });
  });
  provider.on("grant.error", (ctx, error) => {
    log.warn("oidc.grant_error", { path: ctx.path, error: error.message });
  });
  provider.on("authorization.error", (ctx, error) => {
    log.warn("oidc.authorization_error", { path: ctx.path, error: error.message });
  });
}

// For the pages oidc-provider renders through our templates.
function setPageHeaders(ctx: { set(fields: Record<string, string>): void }): void {
  ctx.set({ ...SECURITY_HEADERS, "cache-control": "no-store" });
}
