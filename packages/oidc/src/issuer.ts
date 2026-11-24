// Routing, cookie paths and the interaction callback URL are all anchored at the root, so the
// issuer has to be an origin. A trailing slash is stripped so it matches the `iss` clients compare.
export function parseIssuer(raw: string, errors: string[], name = "issuer"): string {
  if (raw === "") return "";
  const problem = (why: string): string => {
    errors.push(`${name} ${JSON.stringify(raw)} ${why}`);
    return "";
  };
  if (!URL.canParse(raw)) return problem("is not a valid URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") return problem("must be http(s)");
  if (url.username || url.password) return problem("must not contain credentials");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw.includes("?")) {
    return problem("must be a root URL: no path, query or fragment (the provider is served at /)");
  }
  return url.origin;
}
