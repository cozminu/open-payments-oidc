import type {
  GrantContinuation,
  GrantContinuationRequest,
  GrantRequest,
  GrantStart,
  OpenPaymentsGateway,
  WalletAddressLookup,
} from "../../src/wallet/open-payments-gateway.ts";

export const WALLET_ADDRESS = "https://wallet.example/alice";
export const AUTH_SERVER = "https://auth.example/tenant";
export const INTERACT_REDIRECT = "https://auth.example/interact/1";
export const INTERACT_NONCE = "interact-nonce";
export const CONTINUE_URL = "https://auth.example/continue/1";
export const CONTINUE_TOKEN = "continue-token";

export const FOUND: WalletAddressLookup = {
  kind: "found",
  walletAddressUrl: WALLET_ADDRESS,
  walletAddressId: WALLET_ADDRESS,
  authServer: AUTH_SERVER,
};

export const PENDING: GrantStart = {
  kind: "pending",
  redirectUrl: INTERACT_REDIRECT,
  interactNonce: INTERACT_NONCE,
  continueUrl: CONTINUE_URL,
  continueAccessToken: CONTINUE_TOKEN,
};

export const VERIFIED: GrantContinuation = { kind: "continued", subjectIds: [WALLET_ADDRESS] };

export type InMemoryGatewayOptions = {
  readonly lookup?: WalletAddressLookup;
  readonly grant?: GrantStart;
  readonly continuation?: GrantContinuation;
};

/** An Open Payments gateway that answers with fixed results and records what it was asked. */
export class InMemoryGateway implements OpenPaymentsGateway {
  public readonly lookups: string[] = [];
  public readonly grantRequests: GrantRequest[] = [];
  public readonly continuations: GrantContinuationRequest[] = [];
  private readonly options: InMemoryGatewayOptions;

  public constructor(options: InMemoryGatewayOptions = {}) {
    this.options = options;
  }

  public async fetchWalletAddress(raw: string): Promise<WalletAddressLookup> {
    this.lookups.push(raw);
    return this.options.lookup ?? FOUND;
  }

  public async requestGrant(request: GrantRequest): Promise<GrantStart> {
    this.grantRequests.push(request);
    return this.options.grant ?? PENDING;
  }

  public async continueGrant(request: GrantContinuationRequest): Promise<GrantContinuation> {
    this.continuations.push(request);
    return this.options.continuation ?? VERIFIED;
  }
}
