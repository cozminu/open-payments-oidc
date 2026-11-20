import assert from "node:assert/strict";
import { test } from "node:test";
import { OutboundPolicy, type OutboundPolicyOptions } from "../../src/wallet/outbound.ts";
import { failingLookup, PUBLIC_ADDRESS, stubLookup } from "../support/lookup.ts";

const ALICE = "https://ilp.interledger-test.dev/alice";

function policy(options: Partial<OutboundPolicyOptions> = {}): OutboundPolicy {
  return new OutboundPolicy({
    allowHttp: false,
    authServerOrigins: ["https://auth.interledger-test.dev"],
    lookup: stubLookup(PUBLIC_ADDRESS),
    ...options,
  });
}

test("resolveWalletAddress normalizes payment pointers, whitespace and plain urls", async () => {
  const strict = policy();
  const results = [];
  for (const raw of [
    "$ilp.interledger-test.dev/alice",
    " https://ilp.interledger-test.dev/alice ",
    ALICE,
  ]) {
    results.push(await strict.resolveWalletAddress(raw));
  }
  assert.deepEqual(results, [
    { kind: "allowed", url: ALICE },
    { kind: "allowed", url: ALICE },
    { kind: "allowed", url: ALICE },
  ]);
});

test("resolveWalletAddress looks up the hostname of the normalized url", async () => {
  const lookup = stubLookup(PUBLIC_ADDRESS);
  await policy({ lookup }).resolveWalletAddress(" $ilp.interledger-test.dev/alice ");
  assert.deepEqual(lookup.hostnames, ["ilp.interledger-test.dev"]);
});

test("resolveWalletAddress rejects http unless allowHttp", async () => {
  assert.deepEqual(await policy().resolveWalletAddress("http://x/alice"), {
    kind: "unparseable",
  });
  assert.deepEqual(await policy({ allowHttp: true }).resolveWalletAddress("http://x/alice"), {
    kind: "allowed",
    url: "http://x/alice",
  });
});

test("resolveWalletAddress rejects non-urls, other schemes and credentials", async () => {
  const lenient = policy({ allowHttp: true });
  for (const raw of [
    "not a url",
    "",
    "ftp://x/alice",
    "javascript:alert(1)",
    "https://user:pw@x/alice",
  ]) {
    assert.deepEqual(await lenient.resolveWalletAddress(raw), { kind: "unparseable" }, raw);
  }
});

test("resolveWalletAddress refuses hosts with any non-public address", async () => {
  const blocked = [
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["192.168.0.1"],
    ["172.16.0.1"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["224.0.0.1"],
    ["::1"],
    ["::"],
    ["fd00::1"],
    ["fe80::1"],
    ["ff02::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:7f00:1"],
    ["::ffff:10.0.0.1"],
    [PUBLIC_ADDRESS, "10.0.0.1"],
  ];
  for (const addresses of blocked) {
    const result = await policy({ lookup: stubLookup(...addresses) }).resolveWalletAddress(ALICE);
    assert.deepEqual(
      result,
      { kind: "unreachable", url: ALICE, error: "host resolves to a non-public address" },
      addresses.join(","),
    );
  }
});

test("resolveWalletAddress refuses when nothing resolves or lookup fails", async () => {
  assert.deepEqual(await policy({ lookup: stubLookup() }).resolveWalletAddress(ALICE), {
    kind: "unreachable",
    url: ALICE,
    error: "host did not resolve to any address",
  });
  assert.deepEqual(await policy({ lookup: failingLookup }).resolveWalletAddress(ALICE), {
    kind: "unreachable",
    url: ALICE,
    error: "ENOTFOUND",
  });
});

test("resolveWalletAddress checks ip literals without a lookup", async () => {
  const strict = policy({ lookup: failingLookup });
  assert.deepEqual(await strict.resolveWalletAddress("https://127.0.0.1/alice"), {
    kind: "unreachable",
    url: "https://127.0.0.1/alice",
    error: "host resolves to a non-public address",
  });
  assert.deepEqual(await strict.resolveWalletAddress("https://[::1]/alice"), {
    kind: "unreachable",
    url: "https://[::1]/alice",
    error: "host resolves to a non-public address",
  });
  assert.deepEqual(await strict.resolveWalletAddress(`https://${PUBLIC_ADDRESS}/alice`), {
    kind: "allowed",
    url: `https://${PUBLIC_ADDRESS}/alice`,
  });
});

test("resolveWalletAddress accepts hosts with only public addresses", async () => {
  const lookup = stubLookup(PUBLIC_ADDRESS, "2606:2800:220:1:248:1893:25c8:1946");
  assert.deepEqual(await policy({ lookup }).resolveWalletAddress(ALICE), {
    kind: "allowed",
    url: ALICE,
  });
});

test("resolveWalletAddress skips the host check when allowHttp", async () => {
  const lookup = stubLookup("127.0.0.1");
  assert.deepEqual(
    await policy({ allowHttp: true, lookup }).resolveWalletAddress("http://127.0.0.1:1/alice"),
    { kind: "allowed", url: "http://127.0.0.1:1/alice" },
  );
  assert.deepEqual(lookup.hostnames, []);
});

test("allowsCredentialTarget compares origins and ignores paths", () => {
  const strict = policy();
  assert.equal(
    strict.allowsCredentialTarget(
      "https://auth.interledger-test.dev/f537937b-7016-481b-b655-9f0d1014822c",
    ),
    true,
  );
  assert.deepEqual(
    [
      "https://auth.example.com/",
      "http://auth.interledger-test.dev/x",
      "https://auth.interledger-test.dev:8443/x",
      "https://auth.interledger-test.dev.evil.example/x",
      "not a url",
    ].map((url) => strict.allowsCredentialTarget(url)),
    [false, false, false, false, false],
  );
});

test("allowsCredentialTarget refuses http origins unless allowHttp, even when allowlisted", () => {
  const origins = ["https://auth.example", "http://local.example"];
  const table: [url: string, allowHttp: boolean, expected: boolean][] = [
    ["https://auth.example/continue/1", false, true],
    ["https://auth.example/continue/1", true, true],
    ["http://local.example/continue/1", false, false],
    ["http://local.example/continue/1", true, true],
    ["http://auth.example/continue/1", true, false],
  ];
  for (const [url, allowHttp, expected] of table) {
    const result = policy({ allowHttp, authServerOrigins: origins }).allowsCredentialTarget(url);
    assert.equal(result, expected, `${url} allowHttp=${allowHttp}`);
  }
});

test("allowsBrowserRedirect allows https, and http only when allowHttp", () => {
  const table: [url: string, allowHttp: boolean, expected: boolean][] = [
    ["https://wallet.example/interact/1", false, true],
    ["http://wallet.example/interact/1", false, false],
    ["http://wallet.example/interact/1", true, true],
    ["javascript:alert(1)", true, false],
    ["ftp://wallet.example/x", true, false],
    ["not a url", true, false],
  ];
  for (const [url, allowHttp, expected] of table) {
    assert.equal(policy({ allowHttp }).allowsBrowserRedirect(url), expected, url);
  }
});

test("sdkOptions use http exactly when allowHttp", () => {
  assert.deepEqual(policy().sdkOptions, { useHttp: false });
  assert.deepEqual(policy({ allowHttp: true }).sdkOptions, { useHttp: true });
});

test("the default lookup is dns", async () => {
  const strict = new OutboundPolicy({ allowHttp: false, authServerOrigins: [] });
  const result = await strict.resolveWalletAddress("https://localhost/alice");
  assert.equal(result.kind, "unreachable");
});
