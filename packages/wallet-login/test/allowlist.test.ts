import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthServerAllowlist } from "../src/allowlist.ts";

const ENV_NAMES = { list: "AUTH_SERVER_ALLOWLIST", allowHttp: "ALLOW_HTTP" };

function run(entries: string[], allowHttp: boolean, names?: typeof ENV_NAMES) {
  const errors: string[] = [];
  const origins = parseAuthServerAllowlist(entries, allowHttp, errors, names);
  return { origins, errors };
}

test("typed names are the default", () => {
  assert.deepEqual(run([], false).errors, ["authServerAllowlist must list at least one origin"]);
  assert.deepEqual(run(["*"], false).errors, ['authServerAllowlist entry "*" is not a valid URL']);
  assert.deepEqual(run(["http://x.example"], false).errors, [
    'authServerAllowlist entry "http://x.example" must be https unless allowHttp=true',
  ]);
  assert.deepEqual(run(["ftp://x.example"], false).errors, [
    'authServerAllowlist entry "ftp://x.example" must be http(s)',
  ]);
  assert.deepEqual(run(["https://x.example/path"], false).errors, [
    'authServerAllowlist entry "https://x.example/path" must be an origin with no path, query, fragment, or credentials',
  ]);
});

test("env names show up in messages when given", () => {
  assert.deepEqual(run([], false, ENV_NAMES).errors, [
    "AUTH_SERVER_ALLOWLIST must list at least one origin",
  ]);
  assert.deepEqual(run(["http://x.example"], false, ENV_NAMES).errors, [
    'AUTH_SERVER_ALLOWLIST entry "http://x.example" must be https unless ALLOW_HTTP=true',
  ]);
});

test("valid entries become deduplicated origins", () => {
  const { origins, errors } = run(
    ["https://a.example", "https://a.example/", "http://b.example:8080"],
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(origins, ["https://a.example", "http://b.example:8080"]);
});
