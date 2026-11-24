import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/env.ts";

const minimal = {
  ISSUER: "https://id.example.com",
  DATABASE_URL: "postgres://localhost/oidc",
  OP_WALLET_ADDRESS: "https://wallet.example.com/provider",
  OP_KEY_ID: "key-1",
  OP_PRIVATE_KEY_PATH: "/secrets/private.key",
  COOKIE_KEYS: "secret-a,secret-b",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(minimal);
    assert.equal(config.issuer, "https://id.example.com");
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, "postgres://localhost/oidc");
    assert.equal(config.opWalletAddress, "https://wallet.example.com/provider");
    assert.equal(config.opKeyId, "key-1");
    assert.equal(config.opPrivateKeyPath, "/secrets/private.key");
    assert.equal(config.clientsFile, "/config/clients.json");
    assert.equal(config.jwksFile, "/config/jwks.json");
    assert.deepEqual(config.cookieKeys, ["secret-a", "secret-b"]);
    assert.equal(config.sessionTtlSeconds, 3600);
    assert.deepEqual(config.authServerAllowlist, ["https://auth.interledger-test.dev"]);
    assert.equal(config.allowHttp, false);
    assert.equal(config.trustProxy, true);
    assert.equal(config.rateLimitPerMinute, 20);
    assert.equal(config.outboundTimeoutMs, 5000);
  });

  test("reports all missing vars", () => {
    assert.throws(
      () => loadConfig({}),
      (err: Error) => {
        for (const name of [
          "ISSUER",
          "DATABASE_URL",
          "OP_WALLET_ADDRESS",
          "OP_KEY_ID",
          "OP_PRIVATE_KEY_PATH",
          "COOKIE_KEYS",
        ]) {
          assert.match(err.message, new RegExp(name));
        }
        return true;
      },
    );
  });

  test("treats empty required vars as missing", () => {
    assert.throws(() => loadConfig({ ...minimal, ISSUER: "" }), /ISSUER/);
    assert.throws(() => loadConfig({ ...minimal, COOKIE_KEYS: " , " }), /COOKIE_KEYS/);
  });

  test("normalizes allowlist", () => {
    const config = loadConfig({
      ...minimal,
      AUTH_SERVER_ALLOWLIST: "https://Auth.Example.com/, https://auth.interledger-test.dev",
    });
    assert.deepEqual(config.authServerAllowlist, [
      "https://auth.example.com",
      "https://auth.interledger-test.dev",
    ]);
  });

  test("rejects empty, wildcard, and pathful allowlist entries", () => {
    for (const value of [
      "",
      "  ",
      "*",
      "https://a.example,*",
      "https://a.example/x",
      "not a url",
    ]) {
      assert.throws(
        () => loadConfig({ ...minimal, AUTH_SERVER_ALLOWLIST: value }),
        /AUTH_SERVER_ALLOWLIST/,
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  test("rejects http allowlist entries unless ALLOW_HTTP", () => {
    assert.throws(
      () => loadConfig({ ...minimal, AUTH_SERVER_ALLOWLIST: "https://a.example,http://b.example" }),
      /AUTH_SERVER_ALLOWLIST entry "http:\/\/b.example" must be https unless ALLOW_HTTP=true/,
    );
    const config = loadConfig({
      ...minimal,
      AUTH_SERVER_ALLOWLIST: "http://b.example",
      ALLOW_HTTP: "true",
    });
    assert.deepEqual(config.authServerAllowlist, ["http://b.example"]);
  });

  test("rejects non-numeric PORT", () => {
    assert.throws(() => loadConfig({ ...minimal, PORT: "abc" }), /PORT/);
  });

  test("parses overrides", () => {
    const config = loadConfig({
      ...minimal,
      PORT: "8080",
      SESSION_TTL_SECONDS: "60",
      ALLOW_HTTP: "true",
      TRUST_PROXY: "false",
      RATE_LIMIT_PER_MINUTE: "5",
      OUTBOUND_TIMEOUT_MS: "1000",
      CLIENTS_FILE: "./c.json",
      JWKS_FILE: "./j.json",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.sessionTtlSeconds, 60);
    assert.equal(config.allowHttp, true);
    assert.equal(config.trustProxy, false);
    assert.equal(config.rateLimitPerMinute, 5);
    assert.equal(config.outboundTimeoutMs, 1000);
    assert.equal(config.clientsFile, "./c.json");
    assert.equal(config.jwksFile, "./j.json");
  });

  test("rejects invalid booleans and out-of-range numbers", () => {
    assert.throws(() => loadConfig({ ...minimal, ALLOW_HTTP: "yes" }), /ALLOW_HTTP/);
    assert.throws(() => loadConfig({ ...minimal, PORT: "70000" }), /PORT/);
    assert.throws(
      () => loadConfig({ ...minimal, SESSION_TTL_SECONDS: "0" }),
      /SESSION_TTL_SECONDS/,
    );
  });

  test("strips a trailing slash from the issuer", () => {
    assert.equal(
      loadConfig({ ...minimal, ISSUER: "https://id.example.com/" }).issuer,
      "https://id.example.com",
    );
    assert.equal(
      loadConfig({ ...minimal, ISSUER: "http://localhost:3000" }).issuer,
      "http://localhost:3000",
    );
  });

  test("rejects issuers that are not a root http(s) URL", () => {
    for (const value of [
      "id.example.com",
      "ftp://id.example.com",
      "https://id.example.com/op",
      "https://id.example.com/op/",
      "https://id.example.com/?a=b",
      "https://id.example.com/#frag",
      "https://id.example.com?a=b",
      "https://user:pass@id.example.com",
    ]) {
      assert.throws(
        () => loadConfig({ ...minimal, ISSUER: value }),
        /ISSUER/,
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  test("issuer errors are aggregated with the other errors", () => {
    assert.throws(
      () => loadConfig({ ...minimal, ISSUER: "https://id.example.com/op", PORT: "abc" }),
      (err: Error) => /ISSUER/.test(err.message) && /PORT/.test(err.message),
    );
  });
});
