import { createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { parseAuthServerAllowlist } from "./allowlist.ts";
import { silentLogger, type Logger } from "./log.ts";
import { SdkOpenPaymentsGateway } from "./open-payments-gateway.ts";
import { OutboundPolicy } from "./outbound.ts";
import type { PendingLoginStore } from "./pending-login-store.ts";
import {
  callbackParamsFrom,
  WalletVerifier,
  type CallbackParams,
  type FinishOutcome,
} from "./verifier.ts";

/** The provider's own Open Payments identity, which auth servers know our key by. */
export type OpWallet = {
  address: string;
  keyId: string;
  /** An Ed25519 key, or its PEM text. Never a file path. */
  privateKey: KeyObject | string;
};

export type WalletLoginConfig = {
  wallet: OpWallet;
  /** Origins of the auth servers we have a client key arrangement with. No "*". */
  authServerAllowlist: readonly string[];
  /** Local development only: allows http. Default false. */
  allowHttp?: boolean;
  /** Timeout for each request to a wallet or auth server, 1 to 600000. Default 5000. */
  outboundTimeoutMs?: number;
  /** How long a started login can be finished, in seconds. Default 600. */
  loginTtlSeconds?: number;
  store: PendingLoginStore;
  /** Default: no logging. */
  log?: Logger;
};

export type WalletLoginStart =
  | { kind: "redirect"; loginId: string; redirectUrl: string }
  | { kind: "invalid_input"; message: string }
  | { kind: "failed"; reason: string };

export type WalletLogin = {
  /** Never throws. Keep `loginId` in the user's own session, never in the callback URL. */
  start(
    rawWalletAddress: string,
    callbackUrl: string,
    options?: { loginId?: string },
  ): Promise<WalletLoginStart>;
  /** Single use per `loginId`. Never throws. */
  finish(loginId: string, params: URLSearchParams | CallbackParams): Promise<FinishOutcome>;
  /** Idempotent. Closes the store; later `start` and `finish` calls fail cleanly. */
  close(): Promise<void>;
};

const CLOSED = "Something went wrong. Please try again.";

/** Proves a user controls a wallet address. Rejects with every config problem at once. */
export async function createWalletLogin(config: WalletLoginConfig): Promise<WalletLogin> {
  const errors: string[] = [];
  const allowHttp = config.allowHttp ?? false;
  const outboundTimeoutMs = config.outboundTimeoutMs ?? 5000;
  const loginTtlSeconds = config.loginTtlSeconds ?? 600;

  const privateKey = parseOpWallet(config.wallet, errors);
  const origins = parseAuthServerAllowlist(config.authServerAllowlist ?? [], allowHttp, errors);
  if (!isIntegerBetween(outboundTimeoutMs, 1, 600_000)) {
    errors.push(
      `outboundTimeoutMs must be an integer between 1 and 600000 (got ${outboundTimeoutMs})`,
    );
  }
  if (!isIntegerBetween(loginTtlSeconds, 1, 31_536_000)) {
    errors.push(
      `loginTtlSeconds must be an integer between 1 and 31536000 (got ${loginTtlSeconds})`,
    );
  }
  if (config.store === undefined) errors.push("store is required");
  if (errors.length > 0 || privateKey === undefined) {
    throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }

  const outbound = new OutboundPolicy({ allowHttp, authServerOrigins: origins });
  const gateway = await SdkOpenPaymentsGateway.create({
    walletAddressUrl: config.wallet.address,
    keyId: config.wallet.keyId,
    privateKey,
    requestTimeoutMs: outboundTimeoutMs,
    outbound,
  });
  const verifier = new WalletVerifier({
    gateway,
    store: config.store,
    loginTtlSeconds,
    log: config.log ?? silentLogger,
  });

  let closing: Promise<void> | undefined;
  return {
    async start(rawWalletAddress, callbackUrl, options) {
      if (closing !== undefined) return { kind: "failed", reason: CLOSED };
      const loginId = options?.loginId ?? randomBytes(24).toString("base64url");
      const outcome = await verifier.start(loginId, rawWalletAddress, callbackUrl);
      return outcome.kind === "redirect" ? { ...outcome, loginId } : outcome;
    },
    async finish(loginId, params) {
      if (closing !== undefined) return { kind: "failed", reason: CLOSED };
      const callback = params instanceof URLSearchParams ? callbackParamsFrom(params) : params;
      return verifier.finish(loginId, callback);
    },
    close() {
      closing ??= Promise.resolve(config.store.close?.());
      return closing;
    },
  };
}

/** Checks the wallet identity and returns the parsed key. Problems are pushed onto `errors`. */
export function parseOpWallet(
  wallet: OpWallet | undefined,
  errors: string[],
): KeyObject | undefined {
  if (!wallet?.address) errors.push("wallet.address is required");
  if (!wallet?.keyId) errors.push("wallet.keyId is required");
  return parsePrivateKey(wallet?.privateKey, errors);
}

function isIntegerBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

// A string is PEM text only if it has a PEM header; anything else (a path, say) is refused rather
// than handed to the SDK, which would read it as a file.
function parsePrivateKey(
  raw: KeyObject | string | undefined,
  errors: string[],
): KeyObject | undefined {
  const mustBePem = "wallet.privateKey must be PEM text or a KeyObject";
  const mustBeEd25519 = "wallet.privateKey must be an Ed25519 private key";
  let key: KeyObject;
  if (typeof raw === "string") {
    if (!raw.includes("-----BEGIN ")) {
      errors.push(mustBePem);
      return undefined;
    }
    try {
      key = createPrivateKey(raw);
    } catch {
      errors.push("wallet.privateKey is not a valid PEM private key");
      return undefined;
    }
  } else if (raw !== null && typeof raw === "object" && raw.type === "private") {
    key = raw;
  } else {
    errors.push(mustBePem);
    return undefined;
  }
  if (key.asymmetricKeyType !== "ed25519") {
    errors.push(mustBeEd25519);
    return undefined;
  }
  return key;
}
