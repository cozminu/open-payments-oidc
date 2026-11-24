import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadJwks } from "../src/keys.ts";

function write(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "jwks-"));
  const path = join(dir, "jwks.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateRsa = { ...rsa.privateKey.export({ format: "jwk" }), kid: "rsa-1" };
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateEc = { ...ec.privateKey.export({ format: "jwk" }), kid: "ec-1" };

describe("loadJwks", () => {
  test("accepts a private RSA key", () => {
    const jwks = loadJwks(write({ keys: [privateRsa] }));
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0]?.kty, "RSA");
  });

  test("accepts RSA alongside EC", () => {
    const jwks = loadJwks(write({ keys: [privateEc, privateRsa] }));
    assert.equal(jwks.keys.length, 2);
  });

  test("rejects a key without kid", () => {
    const { kid: _kid, ...noKid } = privateRsa;
    assert.throws(() => loadJwks(write({ keys: [noKid] })), /kid/);
  });

  test("rejects a public-only RSA key", () => {
    const publicRsa = { ...rsa.publicKey.export({ format: "jwk" }), kid: "pub" };
    assert.throws(() => loadJwks(write({ keys: [publicRsa] })), /private|"d"/);
  });

  test("rejects a JWKS with no RSA key", () => {
    assert.throws(() => loadJwks(write({ keys: [privateEc] })), /RSA/);
  });

  test("rejects malformed JWKS", () => {
    assert.throws(() => loadJwks(write({})), /keys/);
    assert.throws(() => loadJwks(write({ keys: [] })), /RSA/);
  });

  test("rejects duplicate kid", () => {
    assert.throws(() => loadJwks(write({ keys: [privateRsa, privateRsa] })), /duplicate/i);
  });
});
