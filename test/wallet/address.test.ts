import assert from "node:assert/strict";
import type dns from "node:dns";
import { test } from "node:test";
import {
  AuthServerAllowlist,
  assertPublicHost,
  toWalletAddressUrl,
} from "../../src/wallet/address.ts";

const ALICE = "https://ilp.interledger-test.dev/alice";

test("toWalletAddressUrl normalizes payment pointers, whitespace and plain urls", () => {
  assert.deepEqual(
    ["$ilp.interledger-test.dev/alice", " https://ilp.interledger-test.dev/alice ", ALICE].map(
      (raw) => toWalletAddressUrl(raw, false),
    ),
    [ALICE, ALICE, ALICE],
  );
});

test("toWalletAddressUrl rejects http unless allowHttp", () => {
  assert.equal(toWalletAddressUrl("http://x/alice", false), undefined);
  assert.equal(toWalletAddressUrl("http://x/alice", true), "http://x/alice");
});

test("toWalletAddressUrl rejects non-urls, other schemes and credentials", () => {
  assert.deepEqual(
    ["not a url", "", "ftp://x/alice", "javascript:alert(1)", "https://user:pw@x/alice"].map(
      (raw) => toWalletAddressUrl(raw, true),
    ),
    [undefined, undefined, undefined, undefined, undefined],
  );
});

test("AuthServerAllowlist compares origins and ignores paths", () => {
  const allowlist = new AuthServerAllowlist(["https://auth.interledger-test.dev"]);
  assert.equal(
    allowlist.allows("https://auth.interledger-test.dev/f537937b-7016-481b-b655-9f0d1014822c"),
    true,
  );
  assert.deepEqual(
    [
      "https://auth.example.com/",
      "http://auth.interledger-test.dev/x",
      "https://auth.interledger-test.dev:8443/x",
      "https://auth.interledger-test.dev.evil.example/x",
      "not a url",
    ].map((url) => allowlist.allows(url)),
    [false, false, false, false, false],
  );
});

function stubLookup(...addresses: string[]): typeof dns.promises.lookup {
  const stub = async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  return stub as unknown as typeof dns.promises.lookup;
}

test("assertPublicHost refuses non-public addresses", async () => {
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
    ["93.184.216.34", "10.0.0.1"],
  ];
  for (const addresses of blocked) {
    await assert.rejects(
      assertPublicHost("https://wallet.example/alice", stubLookup(...addresses)),
      /non-public/,
      addresses.join(","),
    );
  }
});

test("assertPublicHost refuses when nothing resolves or lookup fails", async () => {
  await assert.rejects(assertPublicHost("https://wallet.example/alice", stubLookup()));
  const failing = (async () => {
    throw new Error("ENOTFOUND");
  }) as unknown as typeof dns.promises.lookup;
  await assert.rejects(assertPublicHost("https://wallet.example/alice", failing));
});

test("assertPublicHost checks ip literals without relying on lookup", async () => {
  await assert.rejects(assertPublicHost("https://127.0.0.1/alice"));
  await assert.rejects(assertPublicHost("https://[::1]/alice"));
});

test("assertPublicHost accepts public addresses", async () => {
  await assertPublicHost("https://wallet.example/alice", stubLookup("93.184.216.34"));
  await assertPublicHost(
    "https://wallet.example/alice",
    stubLookup("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"),
  );
});
