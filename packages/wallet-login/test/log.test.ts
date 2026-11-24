import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/log.ts";

function capture(level?: "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line), ...(level ? { level } : {}) });
  return { lines, log };
}

test("writes one parseable JSON object per line with time, level, msg and fields", () => {
  const { lines, log } = capture();
  log.info("login.start", { walletHost: "wallet.example", outcome: "redirect" });
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed["level"], "info");
  assert.equal(parsed["msg"], "login.start");
  assert.equal(parsed["walletHost"], "wallet.example");
  assert.equal(parsed["outcome"], "redirect");
  assert.equal(new Date(String(parsed["time"])).toISOString(), parsed["time"]);
});

test("uses the matching level for warn and error", () => {
  const { lines, log } = capture();
  log.warn("a");
  log.error("b");
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { level: string }).level),
    ["warn", "error"],
  );
});

test("drops lines below the configured level", () => {
  const warnOnly = capture("warn");
  warnOnly.log.info("i");
  warnOnly.log.warn("w");
  warnOnly.log.error("e");
  assert.deepEqual(
    warnOnly.lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
    ["w", "e"],
  );
  const errorOnly = capture("error");
  errorOnly.log.info("i");
  errorOnly.log.warn("w");
  errorOnly.log.error("e");
  assert.equal(errorOnly.lines.length, 1);
});

test("fields cannot overwrite time, level or msg", () => {
  const { lines, log } = capture();
  log.info("real", { level: "error", msg: "fake", time: "never" });
  const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(parsed["level"], "info");
  assert.equal(parsed["msg"], "real");
  assert.notEqual(parsed["time"], "never");
});

test("an Error field logs its message only, without a stack", () => {
  const { lines, log } = capture();
  log.error("boom", { error: new Error("it broke") });
  const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(parsed["error"], "it broke");
  assert.equal((lines[0] ?? "").includes("at "), false);
});

test("never throws on fields that can't be serialized", () => {
  const { lines, log } = capture();
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.doesNotThrow(() => log.info("odd", { circular, big: 1n }));
  const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(parsed["msg"], "odd");
  assert.equal(parsed["level"], "info");
});

test("writes to stdout with a trailing newline by default", (context) => {
  const written: string[] = [];
  context.mock.method(process.stdout, "write", (chunk: string) => {
    written.push(chunk);
    return true;
  });
  createLogger().info("hello");
  assert.equal(written.length, 1);
  assert.ok(written[0]?.endsWith("\n"));
  assert.equal((JSON.parse(written[0] ?? "") as { msg: string }).msg, "hello");
});
