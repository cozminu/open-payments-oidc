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

  const issuer = parseIssuer(required("ISSUER"), errors);
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
  const authServerAllowlist = parseAllowlist(
    env.AUTH_SERVER_ALLOWLIST ?? DEFAULT_ALLOWLIST,
    errors,
  );
  const allowHttp = boolean("ALLOW_HTTP", false);
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

// Routing, cookie paths and the interaction callback URL are all anchored at the root, so the
// issuer has to be an origin. A trailing slash is stripped so it matches the `iss` clients compare.
function parseIssuer(raw: string, errors: string[]): string {
  if (raw === "") return "";
  const problem = (why: string): string => {
    errors.push(`ISSUER ${JSON.stringify(raw)} ${why}`);
    return "";
  };
  if (!URL.canParse(raw)) return problem("is not a valid URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") return problem("must be http(s)");
  if (url.username || url.password) return problem("must not contain credentials");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw.includes("?")) {
    return problem("must be a root URL: no path, query or fragment (the provider is served at /)");
  }
  return url.origin;
}

// There is deliberately no "allow any" escape hatch: "*" and an empty list are errors.
// An explicitly set but blank value fails rather than silently using the default.
function parseAllowlist(raw: string, errors: string[]): string[] {
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

  if (entries.length === 0) {
    errors.push("AUTH_SERVER_ALLOWLIST must list at least one origin");
    return [];
  }

  const origins: string[] = [];
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      errors.push(`AUTH_SERVER_ALLOWLIST entry ${JSON.stringify(entry)} is not a valid URL`);
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      errors.push(`AUTH_SERVER_ALLOWLIST entry ${JSON.stringify(entry)} must be http(s)`);
    } else if (
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username ||
      url.password
    ) {
      errors.push(
        `AUTH_SERVER_ALLOWLIST entry ${JSON.stringify(entry)} must be an origin with no path, query, fragment, or credentials`,
      );
    } else if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}
