import {
  isFinalizedGrantWithSubject,
  isPendingGrant,
  OpenPaymentsClientError,
  type AuthenticatedClient,
} from "@interledger/open-payments";
import { randomBytes } from "node:crypto";
import type { PendingLoginRepo } from "../db/pending-logins.ts";
import type { Logger } from "../log.ts";
import { LoginHash } from "./hash.ts";
import type { OutboundPolicy } from "./outbound.ts";

export type StartOutcome =
  | { kind: "redirect"; redirectUrl: string }
  | { kind: "invalid_input"; message: string }
  | { kind: "failed"; reason: string };

export type FinishOutcome =
  | { kind: "verified"; walletAddress: string }
  | { kind: "denied"; reason: string }
  | { kind: "failed"; reason: string };

export type CallbackParams = { interactRef?: string; hash?: string; result?: string };

export type WalletVerifierOptions = {
  client: AuthenticatedClient;
  pendingLogins: PendingLoginRepo;
  outbound: OutboundPolicy;
  createNonce?: () => string;
  log: Logger;
};

const EXPIRED = "Login expired or already used. Please start again.";
const INTERNAL = "Something went wrong. Please try again.";

/** Proves a user controls a wallet address with an interactive Open Payments subject grant. */
export class WalletVerifier {
  private readonly client: AuthenticatedClient;
  private readonly pendingLogins: PendingLoginRepo;
  private readonly outbound: OutboundPolicy;
  private readonly createNonce: () => string;
  private readonly log: Logger;

  constructor(opts: WalletVerifierOptions) {
    this.client = opts.client;
    this.pendingLogins = opts.pendingLogins;
    this.outbound = opts.outbound;
    this.createNonce = opts.createNonce ?? (() => randomBytes(24).toString("base64url"));
    this.log = opts.log;
  }

  /** Asks the wallet's auth server to verify the user; `callbackUrl` gets the finish redirect. Never throws. */
  async start(uid: string, rawWalletAddress: string, callbackUrl: string): Promise<StartOutcome> {
    const trace: Trace = {};
    let outcome: StartOutcome;
    try {
      outcome = await this.doStart(uid, rawWalletAddress, callbackUrl, trace);
    } catch (error) {
      this.log.error("login.start", {
        ...trace,
        outcome: "failed",
        reason: "internal error",
        error: describeError(error),
      });
      return { kind: "failed", reason: INTERNAL };
    }
    const fields = { ...trace, outcome: outcome.kind };
    if (outcome.kind === "redirect") {
      this.log.info("login.start", fields);
    } else if (outcome.kind === "invalid_input") {
      this.log.info("login.start", { ...fields, reason: trace.reason ?? "invalid input" });
    } else {
      this.log.warn("login.start", { ...fields, reason: trace.reason ?? "failed" });
    }
    return outcome;
  }

  /** Checks the finish redirect and continues the grant. Single use per `uid`. Never throws. */
  async finish(uid: string, params: CallbackParams): Promise<FinishOutcome> {
    const trace: Trace = {};
    let outcome: FinishOutcome;
    try {
      outcome = await this.doFinish(uid, params, trace);
    } catch (error) {
      this.log.error("login.finish", {
        ...trace,
        outcome: "failed",
        reason: "internal error",
        error: describeError(error),
      });
      return { kind: "failed", reason: INTERNAL };
    }
    const fields = { ...trace, outcome: outcome.kind };
    if (outcome.kind === "verified") {
      this.log.info("login.finish", fields);
    } else if (outcome.kind === "denied") {
      this.log.info("login.finish", { ...fields, reason: trace.reason ?? "denied" });
    } else {
      this.log.warn("login.finish", { ...fields, reason: trace.reason ?? "failed" });
    }
    return outcome;
  }

  private async doStart(
    uid: string,
    rawWalletAddress: string,
    callbackUrl: string,
    trace: Trace,
  ): Promise<StartOutcome> {
    const resolution = await this.outbound.resolveWalletAddress(rawWalletAddress);
    if (resolution.kind === "unparseable") {
      trace.reason = "unparseable address";
      return invalid("That doesn't look like a wallet address. Use a https:// URL or $host/name.");
    }
    const walletAddressUrl = resolution.url;
    trace.walletHost = new URL(walletAddressUrl).host;
    if (resolution.kind === "unreachable") {
      trace.reason = "wallet host refused";
      trace.error = resolution.error;
      return invalid("We couldn't reach that wallet address. Check it and try again.");
    }

    let walletAddress;
    try {
      walletAddress = await this.client.walletAddress.get({ url: walletAddressUrl });
    } catch (error) {
      trace.reason = "wallet address fetch failed";
      trace.error = describeError(error);
      return invalid("We couldn't find that wallet address. Check it and try again.");
    }

    const authServer = walletAddress.authServer;
    if (!URL.canParse(authServer)) {
      trace.reason = "invalid auth server";
      return invalid("Your wallet provider isn't supported yet (invalid auth server).");
    }
    const authServerOrigin = new URL(authServer).origin;
    trace.authServerOrigin = authServerOrigin;
    if (!this.outbound.allowsCredentialTarget(authServer)) {
      trace.reason = "auth server not supported";
      return invalid(`Your wallet provider isn't supported yet (auth server ${authServerOrigin}).`);
    }

    const clientNonce = this.createNonce();
    let grant;
    try {
      grant = await this.client.grant.request(
        { url: authServer },
        {
          subject: { sub_ids: [{ id: walletAddress.id, format: "uri" }] },
          interact: {
            start: ["redirect"],
            finish: { method: "redirect", uri: callbackUrl, nonce: clientNonce },
          },
        },
      );
    } catch (error) {
      trace.reason = "grant request failed";
      trace.error = describeError(error);
      return { kind: "failed", reason: "Your wallet provider didn't accept the request." };
    }
    if (!isPendingGrant(grant)) {
      trace.reason = "grant did not ask for interaction";
      return { kind: "failed", reason: "Your wallet provider didn't ask for approval." };
    }

    // The auth server is allowlisted, but what it hands back is still its input: the continue url
    // gets our token and the interact url is where the user's browser goes.
    if (!this.outbound.allowsCredentialTarget(grant.continue.uri)) {
      trace.reason = "continue url not allowed";
      return { kind: "failed", reason: "Your wallet provider's response couldn't be used." };
    }
    if (!this.outbound.allowsBrowserRedirect(grant.interact.redirect)) {
      trace.reason = "interact redirect not allowed";
      return { kind: "failed", reason: "Your wallet provider's response couldn't be used." };
    }
    await this.pendingLogins.save({
      uid,
      walletAddress: walletAddress.id,
      authServerUrl: authServer,
      clientNonce,
      interactNonce: grant.interact.finish,
      continueUrl: grant.continue.uri,
      continueAccessToken: grant.continue.access_token.value,
    });
    return { kind: "redirect", redirectUrl: grant.interact.redirect };
  }

  private async doFinish(
    uid: string,
    params: CallbackParams,
    trace: Trace,
  ): Promise<FinishOutcome> {
    const pending = await this.pendingLogins.take(uid);
    if (pending === undefined) {
      trace.reason = "no pending login";
      return { kind: "failed", reason: EXPIRED };
    }
    const walletHost = new URL(pending.walletAddress).host;
    trace.walletHost = walletHost;

    if (params.result !== undefined) {
      trace.reason = "denied by wallet provider";
      return { kind: "denied", reason: "Your wallet provider didn't approve the request." };
    }
    if (params.interactRef === undefined || params.hash === undefined) {
      trace.reason = "incomplete finish redirect";
      return { kind: "failed", reason: "The wallet provider's response was incomplete." };
    }
    const isHashValid = LoginHash.isValid(
      {
        clientNonce: pending.clientNonce,
        interactNonce: pending.interactNonce,
        interactRef: params.interactRef,
        authServerUrl: pending.authServerUrl,
      },
      params.hash,
    );
    if (!isHashValid) {
      trace.reason = "hash mismatch";
      return { kind: "failed", reason: "The wallet provider's response couldn't be verified." };
    }

    let grant;
    try {
      grant = await this.client.grant.continue(
        { url: pending.continueUrl, accessToken: pending.continueAccessToken },
        { interact_ref: params.interactRef },
      );
    } catch (error) {
      trace.reason = "grant continuation failed";
      trace.error = describeError(error);
      return { kind: "failed", reason: "Your wallet provider didn't confirm the login." };
    }

    // We never asked for access, but if the server hands out a token anyway, don't keep it alive.
    // We'd be sending the token to the manage url.
    const manageUrl = findManageUrl(grant);
    if (manageUrl !== undefined && !this.outbound.allowsCredentialTarget(manageUrl)) {
      trace.reason = "token manage url not allowed";
      return { kind: "failed", reason: "Your wallet provider's response couldn't be used." };
    }
    await this.revokeIfIssued(grant, walletHost);

    if (!isFinalizedGrantWithSubject(grant)) {
      trace.reason = "continuation had no subject";
      return { kind: "failed", reason: "Your wallet provider didn't confirm the wallet address." };
    }
    const isVerified = grant.subject.sub_ids.some(
      (subId) => subId.format === "uri" && subId.id === pending.walletAddress,
    );
    if (!isVerified) {
      trace.reason = "continuation subject mismatch";
      return { kind: "failed", reason: "Your wallet provider didn't confirm the wallet address." };
    }
    return { kind: "verified", walletAddress: pending.walletAddress };
  }

  private async revokeIfIssued(grant: object, walletHost: string): Promise<void> {
    const token = (grant as { access_token?: { value?: unknown; manage?: unknown } }).access_token;
    if (typeof token?.value !== "string" || typeof token.manage !== "string") return;
    try {
      await this.client.token.revoke({ url: token.manage, accessToken: token.value });
    } catch (error) {
      this.log.warn("token.revoke_failed", { walletHost, error: describeError(error) });
    }
  }
}

function findManageUrl(grant: object): string | undefined {
  const token = (grant as { access_token?: { manage?: unknown } }).access_token;
  return typeof token?.manage === "string" ? token.manage : undefined;
}

// What a start or finish learned along the way, logged once as a single event. Never secrets.
type Trace = { walletHost?: string; authServerOrigin?: string; reason?: string; error?: string };

function invalid(message: string): StartOutcome {
  return { kind: "invalid_input", message };
}

// Message and status only. The SDK's `description` can echo response bodies.
function describeError(error: unknown): string {
  if (error instanceof OpenPaymentsClientError) {
    return error.status === undefined ? error.message : `${error.message} (status ${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}
