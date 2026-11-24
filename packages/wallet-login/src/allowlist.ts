export type AllowlistNames = { list: string; allowHttp: string };

const TYPED_NAMES: AllowlistNames = { list: "authServerAllowlist", allowHttp: "allowHttp" };

/**
 * Validates the auth server allowlist and returns it as origins. There is deliberately no "allow
 * any" escape hatch: "*" and an empty list are errors. An http origin without `allowHttp` would
 * never be allowed anyway, so it's a mistake worth failing on at startup. Problems are pushed onto
 * `errors`; `names` is how the list and the flag are spelled in them (env var names for the
 * container, field names for typed config).
 */
export function parseAuthServerAllowlist(
  entries: readonly string[],
  allowHttp: boolean,
  errors: string[],
  names: AllowlistNames = TYPED_NAMES,
): string[] {
  if (entries.length === 0) {
    errors.push(`${names.list} must list at least one origin`);
    return [];
  }

  const origins: string[] = [];
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      errors.push(`${names.list} entry ${JSON.stringify(entry)} is not a valid URL`);
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      errors.push(`${names.list} entry ${JSON.stringify(entry)} must be http(s)`);
    } else if (url.protocol === "http:" && !allowHttp) {
      errors.push(
        `${names.list} entry ${JSON.stringify(entry)} must be https unless ${names.allowHttp}=true`,
      );
    } else if (
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username ||
      url.password
    ) {
      errors.push(
        `${names.list} entry ${JSON.stringify(entry)} must be an origin with no path, query, fragment, or credentials`,
      );
    } else if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}
