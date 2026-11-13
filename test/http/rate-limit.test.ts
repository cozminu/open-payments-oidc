import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { clientIp, RateLimiter } from "../../src/http/rate-limit.ts";

function createClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function fakeRequest(headers: Record<string, string | string[]>, remoteAddress?: string) {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test("allows up to limit then blocks", () => {
  const clock = createClock();
  const limiter = new RateLimiter({ limitPerMinute: 3, now: clock.now });
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(() => limiter.allow("a")),
    [true, true, true, false, false],
  );
});

test("resets after window", () => {
  const clock = createClock();
  const limiter = new RateLimiter({ limitPerMinute: 1, now: clock.now });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  clock.advance(59_999);
  assert.equal(limiter.allow("a"), false);
  clock.advance(1);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
});

test("the window is fixed from the first hit, not sliding", () => {
  const clock = createClock();
  const limiter = new RateLimiter({ limitPerMinute: 2, now: clock.now });
  assert.equal(limiter.allow("a"), true);
  clock.advance(40_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  clock.advance(20_000);
  assert.equal(limiter.allow("a"), true);
});

test("keys are independent", () => {
  const clock = createClock();
  const limiter = new RateLimiter({ limitPerMinute: 1, now: clock.now });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("b"), false);
});

test("many one-off keys expire and the same keys can start over", () => {
  const clock = createClock();
  const limiter = new RateLimiter({ limitPerMinute: 1, now: clock.now });
  for (let index = 0; index < 500; index++) {
    assert.equal(limiter.allow(`ip-${index}`), true);
  }
  clock.advance(60_000);
  // Touching any key after the window is enough to drop the stale ones; all start fresh.
  for (let index = 0; index < 500; index++) {
    assert.equal(limiter.allow(`ip-${index}`), true);
  }
  assert.equal(limiter.allow("ip-0"), false);
});

test("rejects a limit that is not a positive integer", () => {
  for (const limitPerMinute of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new RateLimiter({ limitPerMinute }), RangeError);
  }
});

test("clientIp uses the last forwarded entry only when the proxy is trusted", () => {
  const request = fakeRequest({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }, "10.0.0.2");
  assert.equal(clientIp(request, true), "203.0.113.7");
  assert.equal(clientIp(request, false), "10.0.0.2");
});

test("clientIp ignores a spoofed leftmost entry that the proxy appended after", () => {
  const request = fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, "10.0.0.2");
  assert.equal(clientIp(request, true), "203.0.113.7");
});

test("clientIp falls back to the socket when the header is missing or blank", () => {
  assert.equal(clientIp(fakeRequest({}, "10.0.0.2"), true), "10.0.0.2");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": "  " }, "10.0.0.2"), true), "10.0.0.2");
  assert.equal(
    clientIp(fakeRequest({ "x-forwarded-for": "1.2.3.4, " }, "10.0.0.2"), true),
    "10.0.0.2",
  );
});

test("clientIp trims the entry and handles repeated headers", () => {
  assert.equal(
    clientIp(fakeRequest({ "x-forwarded-for": "x  ,  198.51.100.9  " }), true),
    "198.51.100.9",
  );
  assert.equal(
    clientIp(fakeRequest({ "x-forwarded-for": ["192.0.2.1", "192.0.2.2"] }), true),
    "192.0.2.2",
  );
});

test("clientIp is stable when there is no socket address", () => {
  assert.equal(clientIp(fakeRequest({}), false), "unknown");
});
