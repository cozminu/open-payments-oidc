import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { generateJwks } from "../src/generate-jwks.ts";
import { readJwksFile } from "../../oidc/src/keys.ts";

function writeTemp(t: { after(fn: () => void): void }, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jwks-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jwks.json");
  writeFileSync(path, content);
  return path;
}

describe("generateJwks", () => {
  test("one private RSA signing key with a kid", () => {
    const { keys } = generateJwks({});
    assert.equal(keys.length, 1);
    const key = keys[0] as Record<string, unknown>;
    assert.equal(key.kty, "RSA");
    assert.equal(key.alg, "RS256");
    assert.equal(key.use, "sig");
    assert.equal(typeof key.kid, "string");
    assert.notEqual(key.kid, "");
    assert.equal(typeof key.d, "string");
    // RSA 2048: the modulus is 256 bytes, 342 base64url chars.
    assert.equal((key.n as string).length, 342);
  });

  test("kids are random", () => {
    const a = generateJwks({}).keys[0] as Record<string, unknown>;
    const b = generateJwks({}).keys[0] as Record<string, unknown>;
    assert.notEqual(a.kid, b.kid);
  });

  test("ec adds a P-256 ES256 key after the RSA key", () => {
    const { keys } = generateJwks({ ec: true });
    assert.equal(keys.length, 2);
    const [rsa, ec] = keys as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(rsa.kty, "RSA");
    assert.equal(ec.kty, "EC");
    assert.equal(ec.crv, "P-256");
    assert.equal(ec.alg, "ES256");
    assert.equal(ec.use, "sig");
    assert.equal(typeof ec.d, "string");
    assert.notEqual(ec.kid, rsa.kid);
  });

  test("output is accepted by readJwksFile", (t) => {
    const path = writeTemp(t, JSON.stringify(generateJwks({ ec: true })));
    assert.equal(readJwksFile(path).keys.length, 2);
  });
});

describe("generate-jwks CLI", () => {
  test("prints JSON to stdout that readJwksFile accepts", (t) => {
    const out = execFileSync(
      "node",
      ["--conditions=source", "packages/server/src/generate-jwks.ts", "--ec"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out) as { keys: unknown[] };
    assert.equal(parsed.keys.length, 2);
    assert.equal(readJwksFile(writeTemp(t, out)).keys.length, 2);
  });

  test("rejects unknown flags", () => {
    assert.throws(() =>
      execFileSync(
        "node",
        ["--conditions=source", "packages/server/src/generate-jwks.ts", "--bogus"],
        { stdio: "pipe" },
      ),
    );
  });
});
