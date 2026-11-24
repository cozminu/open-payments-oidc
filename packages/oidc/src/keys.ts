import { readFileSync } from "node:fs";
import type { JsonWebKey } from "node:crypto";

/** Reads and validates a JWKS file. */
export function readJwksFile(path: string): { keys: JsonWebKey[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read JWKS file ${path}: invalid JSON or unreadable (${String(err)})`);
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) {
    throw new Error(`JWKS file ${path} must be an object with a "keys" array`);
  }
  return validateJwks(parsed);
}

/** Validates a JWKS with private signing keys, throwing on the first problem. */
export function validateJwks(value: unknown, label = "jwks"): { keys: JsonWebKey[] } {
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) {
    throw new Error(`${label} must be an object with a "keys" array`);
  }

  const seen = new Set<string>();
  let hasRsa = false;
  for (const [index, key] of keys.entries()) {
    if (typeof key !== "object" || key === null) {
      throw new Error(`JWKS key #${index} must be an object`);
    }
    const jwk = key as JsonWebKey & { kid?: unknown };
    if (typeof jwk.kid !== "string" || jwk.kid === "") {
      throw new Error(`JWKS key #${index} is missing a kid`);
    }
    if (seen.has(jwk.kid)) {
      throw new Error(`Duplicate kid ${JSON.stringify(jwk.kid)} in JWKS`);
    }
    seen.add(jwk.kid);
    if (typeof jwk.d !== "string" || jwk.d === "") {
      throw new Error(
        `JWKS key ${JSON.stringify(jwk.kid)} is public only; a private key (with "d") is required`,
      );
    }
    if (jwk.kty === "RSA") hasRsa = true;
  }

  if (!hasRsa) {
    throw new Error("JWKS must contain at least one RSA private key (RS256 is the default alg)");
  }
  return { keys: keys as JsonWebKey[] };
}
