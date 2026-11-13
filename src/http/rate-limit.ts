import type { IncomingMessage } from "node:http";

const WINDOW_MS = 60_000;

type Window = { startedAt: number; count: number };

/**
 * Fixed one-minute window per key, in memory (so per replica). Expired windows are swept on
 * access, at most once per window, so the map holds only keys seen in the last minute or so.
 */
export class RateLimiter {
  private readonly limitPerMinute: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();
  private nextSweepAt = 0;

  constructor(opts: { limitPerMinute: number; now?: () => number }) {
    if (!Number.isInteger(opts.limitPerMinute) || opts.limitPerMinute < 1) {
      throw new RangeError(`limitPerMinute must be a positive integer, got ${opts.limitPerMinute}`);
    }
    this.limitPerMinute = opts.limitPerMinute;
    this.now = opts.now ?? Date.now;
  }

  /** Counts a hit for `key`; false once the key is over its limit for the current window. */
  allow(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    const current = this.windows.get(key);
    if (current === undefined || now - current.startedAt >= WINDOW_MS) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.limitPerMinute) return false;
    current.count += 1;
    return true;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + WINDOW_MS;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(key);
    }
  }
}

/**
 * The caller's address: with `trustProxy`, the last `X-Forwarded-For` entry, which is the one the
 * trusted proxy appended (earlier entries are client-supplied and spoofable). Assumes exactly one
 * trusted proxy hop, and works too if that proxy overwrites the header. Otherwise the socket
 * address.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const last = (Array.isArray(header) ? header.at(-1) : header)?.split(",").at(-1)?.trim();
    if (last !== undefined && last !== "") return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
