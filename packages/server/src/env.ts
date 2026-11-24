import { readFileSync } from "node:fs";
import { parseIssuer, readClientsFile, readJwksFile } from "@open-payments-oidc/oidc";
import { parseAuthServerAllowlist } from "@open-payments-oidc/wallet-login";
import type { ServerConfig } from "./start-server.ts";

export type Config = {
  issuer: string;
  port: number;
  databaseUrl: string;
  opWalletAddress: string;
  opKeyId: string;
  opPrivateKeyPath: string;
  clientsFile: string;
  jwksFile: string;
  cookieKeys: string[];
  sessionTtlSeconds: number;
  authServerAllowlist: string[];
  allowHttp: boolean;
  trustProxy: boolean;
  rateLimitPerMinute: number;
  outboundTimeoutMs: number;
};

const DEFAULT_ALLOWLIST = "https://auth.interledger-test.dev";

/** The environment as typed config, with the clients, JWKS and private key files read. */
export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  const config = loadConfig(env);
  const clients = readClientsFile(config.clientsFile);
  const jwks = readJwksFile(config.jwksFile);
  return {
    issuer: config.issuer,
    port: config.port,
    database: config.databaseUrl,
    wallet: {
      address: config.opWalletAddress,
      keyId: config.opKeyId,
      privateKey: readPrivateKey(config.opPrivateKeyPath),
    },
    clients,
    jwks,
    cookieKeys: config.cookieKeys,
    sessionTtlSeconds: config.sessionTtlSeconds,
    authServerAllowlist: config.authServerAllowlist,
    allowHttp: config.allowHttp,
    trustProxy: config.trustProxy,
    rateLimitPerMinute: config.rateLimitPerMinute,
    outboundTimeoutMs: config.outboundTimeoutMs,
  };
}

function readPrivateKey(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`OP_PRIVATE_KEY_PATH ${JSON.stringify(path)} could not be read (${code})`);
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const errors: string[] = [];

  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) {
      errors.push(`${name} is required`);
      return "";
    }
    return value;
  }

  function optional(name: string, fallback: string): string {
    const value = env[name]?.trim();
    return value ? value : fallback;
  }

  function integer(name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      errors.push(
        `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`,
      );
      return fallback;
    }
    return value;
  }

  function boolean(name: string, fallback: boolean): boolean {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    errors.push(`${name} must be "true" or "false" (got ${JSON.stringify(env[name])})`);
    return fallback;
  }

  function list(raw: string): string[] {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  const issuer = parseIssuer(required("ISSUER"), errors, "ISSUER");
  const port = integer("PORT", 3000, 1, 65535);
  const databaseUrl = required("DATABASE_URL");
  const opWalletAddress = required("OP_WALLET_ADDRESS");
  const opKeyId = required("OP_KEY_ID");
  const opPrivateKeyPath = required("OP_PRIVATE_KEY_PATH");
  const clientsFile = optional("CLIENTS_FILE", "/config/clients.json");
  const jwksFile = optional("JWKS_FILE", "/config/jwks.json");

  const cookieKeys = list(env.COOKIE_KEYS ?? "");
  if (cookieKeys.length === 0) errors.push("COOKIE_KEYS is required (comma-separated)");

  const sessionTtlSeconds = integer("SESSION_TTL_SECONDS", 3600, 1, 31_536_000);
  const allowHttp = boolean("ALLOW_HTTP", false);
  const authServerAllowlist = parseAuthServerAllowlist(
    list(env.AUTH_SERVER_ALLOWLIST ?? DEFAULT_ALLOWLIST),
    allowHttp,
    errors,
    { list: "AUTH_SERVER_ALLOWLIST", allowHttp: "ALLOW_HTTP" },
  );
  const trustProxy = boolean("TRUST_PROXY", true);
  const rateLimitPerMinute = integer("RATE_LIMIT_PER_MINUTE", 20, 1, 1_000_000);
  const outboundTimeoutMs = integer("OUTBOUND_TIMEOUT_MS", 5000, 1, 600_000);

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }

  return {
    issuer,
    port,
    databaseUrl,
    opWalletAddress,
    opKeyId,
    opPrivateKeyPath,
    clientsFile,
    jwksFile,
    cookieKeys,
    sessionTtlSeconds,
    authServerAllowlist,
    allowHttp,
    trustProxy,
    rateLimitPerMinute,
    outboundTimeoutMs,
  };
}
