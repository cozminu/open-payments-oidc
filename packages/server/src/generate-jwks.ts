import { generateKeyPairSync, randomBytes, type JsonWebKey } from "node:crypto";

type SigningKey = JsonWebKey & { kid: string; alg: string; use: string };

function newKid(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * A JWKS with private signing keys: RSA 2048 (RS256, the default every client supports), plus a
 * P-256 key (ES256) when `ec` is set. The first key signs ID tokens.
 */
export function generateJwks(opts: { ec?: boolean }): { keys: JsonWebKey[] } {
  const keys: SigningKey[] = [];
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  keys.push({ ...rsa.export({ format: "jwk" }), kid: newKid(), alg: "RS256", use: "sig" });
  if (opts.ec) {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    keys.push({ ...ec.export({ format: "jwk" }), kid: newKid(), alg: "ES256", use: "sig" });
  }
  return { keys };
}

function run(args: string[]): void {
  const flags = args.filter((arg) => arg !== "--ec");
  if (flags.length > 0) {
    process.stderr.write(`Unknown argument ${flags[0]}\nUsage: generate-jwks [--ec]\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(generateJwks({ ec: args.includes("--ec") }), null, 2)}\n`);
}

if (import.meta.main) run(process.argv.slice(2));
