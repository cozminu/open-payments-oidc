import type { KeyObject } from "node:crypto";
import {
  createAuthenticatedClient,
  isFinalizedGrantWithSubject,
  isPendingGrant,
  OpenPaymentsClientError,
  type AuthenticatedClient,
} from "@interledger/open-payments";
import type { OutboundPolicy } from "./outbound.ts";

export type WalletAddressLookup =
  | {
      readonly kind: "found";
      /** The URL that was fetched, after payment pointer normalization. */
      readonly walletAddressUrl: string;
      /** The wallet address's own `id`, which is what the user is verified as. */
      readonly walletAddressId: string;
      readonly authServer: string;
    }
  | { readonly kind: "unparseable" }
  | { readonly kind: "host_refused"; readonly walletAddressUrl: string; readonly error: string }
  | { readonly kind: "not_found"; readonly walletAddressUrl: string; readonly error: string }
  | { readonly kind: "invalid_auth_server"; readonly walletAddressUrl: string }
  | {
      readonly kind: "auth_server_not_allowed";
      readonly walletAddressUrl: string;
      readonly authServer: string;
    };

export type GrantRequest = {
  readonly walletAddressId: string;
  readonly authServer: string;
  /** Where the auth server sends the user's browser when the interaction finishes. */
  readonly callbackUrl: string;
  readonly nonce: string;
};

export type GrantStart =
  | {
      readonly kind: "pending";
      /** Where to send the user's browser. Safe as a browser redirect. */
      readonly redirectUrl: string;
      readonly interactNonce: string;
      readonly continueUrl: string;
      readonly continueAccessToken: string;
    }
  | { readonly kind: "auth_server_not_allowed" }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "not_interactive" }
  | { readonly kind: "continue_url_not_allowed" }
  | { readonly kind: "interact_redirect_not_allowed" };

export type GrantContinuationRequest = {
  readonly continueUrl: string;
  readonly continueAccessToken: string;
  readonly interactRef: string;
};

export type GrantContinuation =
  | {
      readonly kind: "continued";
      /** Wallet addresses (uri format) the auth server verified, or undefined if it named none. */
      readonly subjectIds: readonly string[] | undefined;
      /** Set when an access token came back and revoking it failed. */
      readonly revokeError?: string;
    }
  | { readonly kind: "continue_url_not_allowed" }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "manage_url_not_allowed" };

/**
 * Makes every request to wallet addresses and auth servers, and refuses any the outbound policy
 * doesn't allow. Every method never throws: failures come back as kinds.
 */
export type OpenPaymentsGateway = {
  /** Normalizes what the user typed, fetches the wallet address and checks its auth server. */
  fetchWalletAddress(raw: string): Promise<WalletAddressLookup>;
  /** Requests an interactive subject-only grant for the wallet address. */
  requestGrant(request: GrantRequest): Promise<GrantStart>;
  /** Continues the grant after the user approved it, revoking any access token that came back. */
  continueGrant(request: GrantContinuationRequest): Promise<GrantContinuation>;
};

export type SdkOpenPaymentsGatewayOptions = {
  /** The provider's own wallet address, which auth servers know our key by. */
  readonly walletAddressUrl: string;
  readonly keyId: string;
  /** The Ed25519 private key, as a KeyObject or PEM text. Never a file path. */
  readonly privateKey: string | KeyObject;
  readonly requestTimeoutMs: number;
  readonly outbound: OutboundPolicy;
};

/** The Open Payments gateway over the Open Payments SDK. */
export class SdkOpenPaymentsGateway implements OpenPaymentsGateway {
  private readonly client: AuthenticatedClient;
  private readonly outbound: OutboundPolicy;

  private constructor(client: AuthenticatedClient, outbound: OutboundPolicy) {
    this.client = client;
    this.outbound = outbound;
  }

  /** Builds the SDK client. Rejects if the key can't be loaded. */
  public static async create(
    options: SdkOpenPaymentsGatewayOptions,
  ): Promise<SdkOpenPaymentsGateway> {
    const client = await createAuthenticatedClient({
      walletAddressUrl: options.walletAddressUrl,
      keyId: options.keyId,
      privateKey: options.privateKey,
      requestTimeoutMs: options.requestTimeoutMs,
      // The SDK's useHttp rewrites every request to http, which is what allowHttp relaxes.
      useHttp: options.outbound.allowHttp,
      // Our own verifier logs outcomes; the SDK's logger isn't needed and is not ours to audit.
      logLevel: "silent",
    });
    return new SdkOpenPaymentsGateway(client, options.outbound);
  }

  public async fetchWalletAddress(raw: string): Promise<WalletAddressLookup> {
    const resolution = await this.outbound.resolveWalletAddress(raw);
    if (resolution.kind === "unparseable") return { kind: "unparseable" };
    const walletAddressUrl = resolution.url;
    if (resolution.kind === "unreachable") {
      return { kind: "host_refused", walletAddressUrl, error: resolution.error };
    }
    let walletAddress;
    try {
      walletAddress = await this.client.walletAddress.get({ url: walletAddressUrl });
    } catch (error) {
      return { kind: "not_found", walletAddressUrl, error: describeError(error) };
    }
    const authServer = walletAddress.authServer;
    if (!URL.canParse(authServer)) return { kind: "invalid_auth_server", walletAddressUrl };
    if (!this.outbound.allowsCredentialTarget(authServer)) {
      return { kind: "auth_server_not_allowed", walletAddressUrl, authServer };
    }
    return { kind: "found", walletAddressUrl, walletAddressId: walletAddress.id, authServer };
  }

  public async requestGrant(request: GrantRequest): Promise<GrantStart> {
    // Checked again here, not only in fetchWalletAddress: every signed request goes through this.
    if (!this.outbound.allowsCredentialTarget(request.authServer)) {
      return { kind: "auth_server_not_allowed" };
    }
    let grant;
    try {
      grant = await this.client.grant.request(
        { url: request.authServer },
        {
          subject: { sub_ids: [{ id: request.walletAddressId, format: "uri" }] },
          interact: {
            start: ["redirect"],
            finish: { method: "redirect", uri: request.callbackUrl, nonce: request.nonce },
          },
        },
      );
    } catch (error) {
      return { kind: "rejected", error: describeError(error) };
    }
    if (!isPendingGrant(grant)) return { kind: "not_interactive" };
    // The auth server is allowlisted, but what it hands back is still its input: the continue url
    // gets our token and the interact url is where the user's browser goes.
    if (!this.outbound.allowsCredentialTarget(grant.continue.uri)) {
      return { kind: "continue_url_not_allowed" };
    }
    if (!this.outbound.allowsBrowserRedirect(grant.interact.redirect)) {
      return { kind: "interact_redirect_not_allowed" };
    }
    return {
      kind: "pending",
      redirectUrl: grant.interact.redirect,
      interactNonce: grant.interact.finish,
      continueUrl: grant.continue.uri,
      continueAccessToken: grant.continue.access_token.value,
    };
  }

  public async continueGrant(request: GrantContinuationRequest): Promise<GrantContinuation> {
    if (!this.outbound.allowsCredentialTarget(request.continueUrl)) {
      return { kind: "continue_url_not_allowed" };
    }
    let grant;
    try {
      grant = await this.client.grant.continue(
        { url: request.continueUrl, accessToken: request.continueAccessToken },
        { interact_ref: request.interactRef },
      );
    } catch (error) {
      return { kind: "rejected", error: describeError(error) };
    }
    // We never asked for access, but if the server hands out a token anyway, don't keep it alive.
    // We'd be sending the token to the manage url.
    const token = (grant as { access_token?: { value?: unknown; manage?: unknown } }).access_token;
    const manageUrl = typeof token?.manage === "string" ? token.manage : undefined;
    if (manageUrl !== undefined && !this.outbound.allowsCredentialTarget(manageUrl)) {
      return { kind: "manage_url_not_allowed" };
    }
    const revokeError =
      manageUrl === undefined || typeof token?.value !== "string"
        ? undefined
        : await this.revoke({ value: token.value, manage: manageUrl });
    const subjectIds = isFinalizedGrantWithSubject(grant)
      ? grant.subject.sub_ids.filter((subId) => subId.format === "uri").map((subId) => subId.id)
      : undefined;
    return revokeError === undefined
      ? { kind: "continued", subjectIds }
      : { kind: "continued", subjectIds, revokeError };
  }

  /** Returns why revoking failed, or undefined if it worked. */
  private async revoke(token: AccessToken): Promise<string | undefined> {
    try {
      await this.client.token.revoke({ url: token.manage, accessToken: token.value });
    } catch (error) {
      return describeError(error);
    }
    return undefined;
  }
}

type AccessToken = { readonly value: string; readonly manage: string };

// Message and status only. The SDK's `description` can echo response bodies.
function describeError(error: unknown): string {
  if (error instanceof OpenPaymentsClientError) {
    return error.status === undefined ? error.message : `${error.message} (status ${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}
