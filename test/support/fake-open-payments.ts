import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SdkOpenPaymentsGateway } from "../../src/wallet/open-payments-gateway.ts";
import type { OutboundPolicy } from "../../src/wallet/outbound.ts";
import type { CallbackParams } from "../../src/wallet/verifier.ts";

export type Approval = "approve" | "reject" | "tamper";

export type FakeOptions = {
  approval?: Approval;
  /** Wallet address path the authorization server claims it verified (default "/alice"). */
  verifiedPath?: string;
  /** Continuation also returns an access token with a manage url. */
  returnAccessToken?: boolean;
  /** Token revocation is refused (403). */
  revokeFails?: boolean;
  /** Value served as `authServer` in wallet address responses (default `<url>/auth`). */
  authServerOverride?: string;
  /** `continue.uri` handed out in the grant response (default `<url>/auth/continue/<id>`). */
  continueUriOverride?: string;
  /** `access_token.manage` in the continuation response (needs returnAccessToken). */
  manageUrlOverride?: string;
  /** `interact.redirect` handed out in the grant response (default `<url>/interact/<id>`). */
  interactRedirectOverride?: string;
  /** Format of the verified subject id in the continuation response (default "uri"). */
  subjectFormat?: string;
};

export type RecordedRequest = { authorization: string | undefined; body?: unknown };

export type Fake = {
  /** Origin of this fake, e.g. http://127.0.0.1:41234 */
  readonly url: string;
  /** Wallet address of the test user served by this fake. */
  readonly walletAddress: string;
  /** Auth server grant endpoint served by this fake. */
  readonly authServer: string;
  /** Paths of wallet address GETs, in order. */
  readonly walletRequests: string[];
  readonly grantRequests: unknown[];
  readonly continueRequests: RecordedRequest[];
  readonly revokeRequests: RecordedRequest[];
  /** Visits the interact redirect like a browser; returns the finish redirect (callback) URL. */
  interact(redirectUrl: string): Promise<URL>;
};

// Values the verifier must never log.
export const FAKE_CONTINUE_TOKEN = "continue-token";
export const FAKE_INTERACT_REF = "interact-ref";
export const FAKE_ISSUED_TOKEN = "issued-token";

type GrantState = { finishUri: string; finishNonce: string; interactNonce: string };

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

// Independent of src/wallet/hash.ts on purpose, so the verifier is checked against the spec formula.
export function interactionHash(
  clientNonce: string,
  interactNonce: string,
  interactRef: string,
  authServerUrl: string,
): string {
  return createHash("sha256")
    .update([clientNonce, interactNonce, interactRef, authServerUrl].join("\n"))
    .digest("base64url");
}

/** Reads the finish redirect query the way the callback endpoint will. */
export function callbackParams(callbackUrl: URL | string): CallbackParams {
  const { searchParams } = new URL(callbackUrl);
  const params: CallbackParams = {};
  const interactRef = searchParams.get("interact_ref");
  const hash = searchParams.get("hash");
  const result = searchParams.get("result");
  if (interactRef !== null) params.interactRef = interactRef;
  if (hash !== null) params.hash = hash;
  if (result !== null) params.result = result;
  return params;
}

/**
 * Wallet address server and authorization server in one, playing a wallet that approves, rejects or
 * tampers when the user visits the interact URL. Listens on a random 127.0.0.1 port.
 */
export async function createFakeOpenPayments(
  context: TestContext,
  options: FakeOptions = {},
): Promise<Fake> {
  const walletRequests: string[] = [];
  const grantRequests: unknown[] = [];
  const continueRequests: RecordedRequest[] = [];
  const revokeRequests: RecordedRequest[] = [];
  const grants = new Map<number, GrantState>();
  let url = "";

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? "";
    const route = `${request.method} ${path}`;
    if (request.method === "GET" && (path === "/alice" || path === "/bob")) {
      walletRequests.push(path);
      sendJson(response, 200, {
        id: `${url}${path}`,
        publicName: path.slice(1),
        assetCode: "USD",
        assetScale: 2,
        authServer: options.authServerOverride ?? `${url}/auth`,
        resourceServer: `${url}/op`,
      });
      return;
    }
    if (route === "POST /auth") {
      const body = await readJson(request);
      grantRequests.push(body);
      const finish = (body.interact as { finish: { uri: string; nonce: string } }).finish;
      const id = grants.size + 1;
      const interactNonce = `as-nonce-${id}`;
      grants.set(id, { finishUri: finish.uri, finishNonce: finish.nonce, interactNonce });
      sendJson(response, 200, {
        interact: {
          redirect: options.interactRedirectOverride ?? `${url}/interact/${id}`,
          finish: interactNonce,
        },
        continue: {
          access_token: { value: FAKE_CONTINUE_TOKEN },
          uri: options.continueUriOverride ?? `${url}/auth/continue/${id}`,
        },
      });
      return;
    }
    const interact = /^GET \/interact\/(\d+)$/.exec(route);
    if (interact) {
      const grant = grants.get(Number(interact[1]));
      if (grant === undefined) {
        sendJson(response, 404, { error: "unknown interaction" });
        return;
      }
      const redirect = new URL(grant.finishUri);
      if (options.approval === "reject") {
        redirect.searchParams.set("result", "grant_rejected");
      } else {
        const hash = interactionHash(
          grant.finishNonce,
          grant.interactNonce,
          FAKE_INTERACT_REF,
          `${url}/auth`,
        );
        redirect.searchParams.set("interact_ref", FAKE_INTERACT_REF);
        redirect.searchParams.set("hash", options.approval === "tamper" ? `x${hash}` : hash);
      }
      response.writeHead(302, { location: redirect.href });
      response.end();
      return;
    }
    const proceed = /^POST \/auth\/continue\/(\d+)$/.exec(route);
    if (proceed) {
      const id = Number(proceed[1]);
      const body = await readJson(request);
      continueRequests.push({ authorization: request.headers.authorization, body });
      if (
        !grants.has(id) ||
        request.headers.authorization !== `GNAP ${FAKE_CONTINUE_TOKEN}` ||
        body.interact_ref !== FAKE_INTERACT_REF
      ) {
        sendJson(response, 401, { error: "invalid_continuation" });
        return;
      }
      sendJson(response, 200, {
        continue: {
          access_token: { value: "next-token" },
          uri: `${url}/auth/continue/${id}`,
        },
        subject: {
          sub_ids: [
            {
              id: `${url}${options.verifiedPath ?? "/alice"}`,
              format: options.subjectFormat ?? "uri",
            },
          ],
        },
        ...(options.returnAccessToken
          ? {
              access_token: {
                value: FAKE_ISSUED_TOKEN,
                manage: options.manageUrlOverride ?? `${url}/auth/token/${id}`,
                expires_in: 600,
                access: [],
              },
            }
          : {}),
      });
      return;
    }
    if (/^DELETE \/auth\/token\/\d+$/.test(route)) {
      revokeRequests.push({ authorization: request.headers.authorization });
      if (options.revokeFails) {
        // 403, not 5xx: the SDK retries DELETE on 5xx, which would make request counts noisy.
        sendJson(response, 403, { error: "revoke_failed" });
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => sendJson(response, 500, { error: "fake failure" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    walletAddress: `${url}/alice`,
    authServer: `${url}/auth`,
    walletRequests,
    grantRequests,
    continueRequests,
    revokeRequests,
    async interact(redirectUrl) {
      const response = await fetch(redirectUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status !== 302 || location === null) {
        throw new Error(`interact endpoint answered ${response.status} without a redirect`);
      }
      return new URL(location);
    },
  };
}

/** Writes a throwaway Ed25519 private key (PKCS8 PEM) to a temp file; removed after the test. */
export async function createTestPrivateKeyFile(context: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "op-oidc-test-key-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("ed25519");
  const path = join(dir, "private.key");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  return path;
}

/** The production gateway with a throwaway key, signing as a provider wallet that doesn't exist. */
export async function createTestGateway(
  context: TestContext,
  outbound: OutboundPolicy,
  options: { requestTimeoutMs?: number } = {},
): Promise<SdkOpenPaymentsGateway> {
  return SdkOpenPaymentsGateway.create({
    walletAddressUrl: "http://127.0.0.1:1/provider",
    keyId: "test-key",
    privateKey: await createTestPrivateKeyFile(context),
    requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    outbound,
  });
}
