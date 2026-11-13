import type { IncomingMessage, ServerResponse } from "node:http";
import { errors } from "oidc-provider";
import type Provider from "oidc-provider";
import type { InteractionResults } from "oidc-provider";
import type { Logger } from "../log.ts";
import type { CallbackParams, WalletVerifier } from "../wallet/verifier.ts";
import { renderErrorPage, renderLoginPage } from "./views.ts";

export type InteractionDeps = { provider: Provider; verifier: WalletVerifier; log: Logger };

type Interaction = Awaited<ReturnType<Provider["interactionDetails"]>>;

/** Largest accepted form body; a wallet address is far shorter. */
export const MAX_FORM_BYTES = 4096;

export const EXPIRED_MESSAGE = "This login expired or was already used. Start again from the app.";
const WRONG_PROMPT = "unexpected interaction prompt";

/** The login interaction: wallet address form, wallet redirect, and the wallet's callback. */
export class InteractionHandlers {
  private readonly provider: Provider;
  private readonly verifier: WalletVerifier;
  private readonly log: Logger;

  constructor(deps: InteractionDeps) {
    this.provider = deps.provider;
    this.verifier = deps.verifier;
    this.log = deps.log;
  }

  /** GET /interaction/:uid */
  async show(req: IncomingMessage, res: ServerResponse, uid: string): Promise<void> {
    const interaction = await this.load(req, res, uid);
    if (interaction === undefined) return;
    if (interaction.prompt.name !== "login") {
      await this.refusePrompt(req, res, interaction);
      return;
    }
    sendHtml(res, 200, renderLoginPage({ uid }));
  }

  /** POST /interaction/:uid with form field `wallet_address`. */
  async submit(req: IncomingMessage, res: ServerResponse, uid: string): Promise<void> {
    const body = await readBody(req, MAX_FORM_BYTES);
    if (body === undefined) {
      sendHtml(res, 413, renderErrorPage("That request was too large.", "Request too large"));
      return;
    }
    const interaction = await this.load(req, res, uid);
    if (interaction === undefined) return;
    if (interaction.prompt.name !== "login") {
      await this.refusePrompt(req, res, interaction);
      return;
    }
    const walletAddress = new URLSearchParams(body).get("wallet_address") ?? "";
    const outcome = await this.verifier.start(uid, walletAddress, this.callbackUrl(uid));
    switch (outcome.kind) {
      case "redirect":
        res.writeHead(303, { location: outcome.redirectUrl, "cache-control": "no-store" });
        res.end();
        return;
      case "invalid_input":
        sendHtml(res, 400, renderLoginPage({ uid, walletAddress, error: outcome.message }));
        return;
      case "failed":
        await this.finish(req, res, { error: "server_error", error_description: outcome.reason });
        return;
    }
  }

  /** GET /interaction/:uid/callback, the wallet's finish redirect. */
  async callback(
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    query: URLSearchParams,
  ): Promise<void> {
    const interaction = await this.load(req, res, uid);
    if (interaction === undefined) return;
    // Already finished and waiting for the browser to resume: a replay must not touch the result.
    if (interaction.result !== undefined) {
      sendExpired(res);
      return;
    }
    if (interaction.prompt.name !== "login") {
      await this.refusePrompt(req, res, interaction);
      return;
    }
    const outcome = await this.verifier.finish(uid, toCallbackParams(query));
    switch (outcome.kind) {
      case "verified":
        // The only place a login result is produced: after the wallet confirmed the address.
        await this.finish(req, res, { login: { accountId: outcome.walletAddress } });
        return;
      case "denied":
        await this.finish(req, res, { error: "access_denied", error_description: outcome.reason });
        return;
      case "failed":
        await this.finish(req, res, { error: "server_error", error_description: outcome.reason });
        return;
    }
  }

  /** Callback URL for `uid`; under `/interaction/<uid>` so the interaction cookie is sent. */
  private callbackUrl(uid: string): string {
    return `${this.provider.issuer.replace(/\/$/, "")}/interaction/${uid}/callback`;
  }

  /** The interaction for this browser, or undefined after sending the expired page. */
  private async load(
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
  ): Promise<Interaction | undefined> {
    let interaction: Interaction;
    try {
      interaction = await this.provider.interactionDetails(req, res);
    } catch (error) {
      if (!(error instanceof errors.SessionNotFound)) throw error;
      sendExpired(res);
      return undefined;
    }
    // The cookie names the browser's current interaction; the URL must agree with it.
    if (interaction.uid !== uid) {
      sendExpired(res);
      return undefined;
    }
    return interaction;
  }

  // loadExistingGrant means only the login prompt should ever get here.
  private async refusePrompt(
    req: IncomingMessage,
    res: ServerResponse,
    interaction: Interaction,
  ): Promise<void> {
    this.log.warn("unexpected interaction prompt", { prompt: interaction.prompt.name });
    await this.finish(req, res, { error: "server_error", error_description: WRONG_PROMPT });
  }

  private async finish(
    req: IncomingMessage,
    res: ServerResponse,
    result: InteractionResults,
  ): Promise<void> {
    await this.provider.interactionFinished(req, res, result, { mergeWithLastSubmission: false });
  }
}

function toCallbackParams(query: URLSearchParams): CallbackParams {
  const params: CallbackParams = {};
  const interactRef = query.get("interact_ref");
  const hash = query.get("hash");
  const result = query.get("result");
  if (interactRef !== null) params.interactRef = interactRef;
  if (hash !== null) params.hash = hash;
  if (result !== null) params.result = result;
  return params;
}

// Past this much an over-limit body is cut off instead of drained, so the socket is dropped.
const MAX_DRAIN_BYTES = 1024 * 1024;

/**
 * Reads the body as UTF-8, or undefined if it's over `maxBytes`. An over-limit body is still
 * drained (up to a cap) so the client gets to read the error response.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DRAIN_BYTES) {
        req.destroy();
        resolve(undefined);
        return;
      }
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(size > maxBytes ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

function sendExpired(res: ServerResponse): void {
  sendHtml(res, 400, renderErrorPage(EXPIRED_MESSAGE, "Login expired"));
}
