import { randomBytes } from "node:crypto";
import type { PendingLoginRepo } from "../db/pending-logins.ts";
import type { Logger } from "../log.ts";
import { LoginHash } from "./hash.ts";
import type { OpenPaymentsGateway } from "./open-payments-gateway.ts";

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
  gateway: OpenPaymentsGateway;
  pendingLogins: PendingLoginRepo;
  createNonce?: () => string;
  log: Logger;
};

const EXPIRED = "Login expired or already used. Please start again.";
const INTERNAL = "Something went wrong. Please try again.";
const UNUSABLE = "Your wallet provider's response couldn't be used.";

/** Proves a user controls a wallet address with an interactive Open Payments subject grant. */
export class WalletVerifier {
  private readonly gateway: OpenPaymentsGateway;
  private readonly pendingLogins: PendingLoginRepo;
  private readonly createNonce: () => string;
  private readonly log: Logger;

  constructor(opts: WalletVerifierOptions) {
    this.gateway = opts.gateway;
    this.pendingLogins = opts.pendingLogins;
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
    const lookup = await this.gateway.fetchWalletAddress(rawWalletAddress);
    if (lookup.kind === "unparseable") {
      trace.reason = "unparseable address";
      return invalid("That doesn't look like a wallet address. Use a https:// URL or $host/name.");
    }
    trace.walletHost = new URL(lookup.walletAddressUrl).host;
    switch (lookup.kind) {
      case "host_refused":
        trace.reason = "wallet host refused";
        trace.error = lookup.error;
        return invalid("We couldn't reach that wallet address. Check it and try again.");
      case "not_found":
        trace.reason = "wallet address fetch failed";
        trace.error = lookup.error;
        return invalid("We couldn't find that wallet address. Check it and try again.");
      case "invalid_auth_server":
        trace.reason = "invalid auth server";
        return invalid("Your wallet provider isn't supported yet (invalid auth server).");
      case "auth_server_not_allowed":
        return unsupportedAuthServer(lookup.authServer, trace);
      case "found":
        break;
    }
    trace.authServerOrigin = new URL(lookup.authServer).origin;

    const clientNonce = this.createNonce();
    const grant = await this.gateway.requestGrant({
      walletAddressId: lookup.walletAddressId,
      authServer: lookup.authServer,
      callbackUrl,
      nonce: clientNonce,
    });
    switch (grant.kind) {
      case "auth_server_not_allowed":
        return unsupportedAuthServer(lookup.authServer, trace);
      case "rejected":
        trace.reason = "grant request failed";
        trace.error = grant.error;
        return { kind: "failed", reason: "Your wallet provider didn't accept the request." };
      case "not_interactive":
        trace.reason = "grant did not ask for interaction";
        return { kind: "failed", reason: "Your wallet provider didn't ask for approval." };
      case "continue_url_not_allowed":
        trace.reason = "continue url not allowed";
        return { kind: "failed", reason: UNUSABLE };
      case "interact_redirect_not_allowed":
        trace.reason = "interact redirect not allowed";
        return { kind: "failed", reason: UNUSABLE };
      case "pending":
        break;
    }
    await this.pendingLogins.save({
      uid,
      walletAddress: lookup.walletAddressId,
      authServerUrl: lookup.authServer,
      clientNonce,
      interactNonce: grant.interactNonce,
      continueUrl: grant.continueUrl,
      continueAccessToken: grant.continueAccessToken,
    });
    return { kind: "redirect", redirectUrl: grant.redirectUrl };
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

    const continuation = await this.gateway.continueGrant({
      continueUrl: pending.continueUrl,
      continueAccessToken: pending.continueAccessToken,
      interactRef: params.interactRef,
    });
    switch (continuation.kind) {
      case "continue_url_not_allowed":
        trace.reason = "continue url not allowed";
        return { kind: "failed", reason: UNUSABLE };
      case "rejected":
        trace.reason = "grant continuation failed";
        trace.error = continuation.error;
        return { kind: "failed", reason: "Your wallet provider didn't confirm the login." };
      case "manage_url_not_allowed":
        trace.reason = "token manage url not allowed";
        return { kind: "failed", reason: UNUSABLE };
      case "continued":
        break;
    }
    if (continuation.revokeError !== undefined) {
      this.log.warn("token.revoke_failed", { walletHost, error: continuation.revokeError });
    }
    if (continuation.subjectIds === undefined) {
      trace.reason = "continuation had no subject";
      return { kind: "failed", reason: "Your wallet provider didn't confirm the wallet address." };
    }
    if (!continuation.subjectIds.includes(pending.walletAddress)) {
      trace.reason = "continuation subject mismatch";
      return { kind: "failed", reason: "Your wallet provider didn't confirm the wallet address." };
    }
    return { kind: "verified", walletAddress: pending.walletAddress };
  }
}

// What a start or finish learned along the way, logged once as a single event. Never secrets.
type Trace = { walletHost?: string; authServerOrigin?: string; reason?: string; error?: string };

function invalid(message: string): StartOutcome {
  return { kind: "invalid_input", message };
}

function unsupportedAuthServer(authServer: string, trace: Trace): StartOutcome {
  const origin = new URL(authServer).origin;
  trace.authServerOrigin = origin;
  trace.reason = "auth server not supported";
  return invalid(`Your wallet provider isn't supported yet (auth server ${origin}).`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
