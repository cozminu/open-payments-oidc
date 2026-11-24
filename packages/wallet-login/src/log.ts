export type LogFields = Record<string, unknown>;

export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
};

export type LogLevel = "info" | "warn" | "error";

export type LoggerOptions = {
  /** Receives one JSON object per call, without a trailing newline. Default: stdout plus "\n". */
  write?: (line: string) => void;
  /** Lines below this level are dropped. Default: "info". */
  level?: LogLevel;
};

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const RESERVED_KEYS = new Set(["time", "level", "msg"]);

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

// An Error logs as its message only: stacks and cause chains can carry request URLs.
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value instanceof Error ? value.message : value;
}

function format(level: LogLevel, msg: string, fields: LogFields | undefined): string {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!RESERVED_KEYS.has(key)) entry[key] = value;
  }
  try {
    return JSON.stringify(entry, replacer);
  } catch {
    // Circular fields or the like: keep the event, drop the details. Logging never throws.
    return JSON.stringify({ time: entry["time"], level, msg, logError: "unserializable fields" });
  }
}

/**
 * JSON-lines logger: `time` (ISO), `level`, `msg`, then the fields. Callers must never pass
 * tokens, codes, nonces or full wallet addresses.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? writeToStdout;
  const minimum = LEVEL_RANK[options.level ?? "info"];
  const emit = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LEVEL_RANK[level] < minimum) return;
    write(format(level, msg, fields));
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const consoleLogger: Logger = createLogger();
