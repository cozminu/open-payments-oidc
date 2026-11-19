import { readFileSync } from "node:fs";

export type ClientConfig = {
  client_id: string;
  /** Shown to users on the sign-in and logout pages. Default: the client_id. */
  client_name?: string;
  client_secret?: string;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  token_endpoint_auth_method?: "client_secret_basic" | "client_secret_post" | "none";
};

const AUTH_METHODS = ["client_secret_basic", "client_secret_post", "none"];

export function loadClients(path: string): ClientConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Cannot read clients file ${path}: invalid JSON or unreadable (${String(err)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Clients file ${path} must contain a JSON array`);
  }

  const seen = new Set<string>();
  return parsed.map((entry: unknown, index: number) => {
    const client = parseClient(entry, index);
    if (seen.has(client.client_id)) {
      throw new Error(`Duplicate client_id ${JSON.stringify(client.client_id)}`);
    }
    seen.add(client.client_id);
    return client;
  });
}

function parseClient(entry: unknown, index: number): ClientConfig {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`Client #${index} must be an object`);
  }
  const raw = entry as Record<string, unknown>;

  const clientId = raw.client_id;
  if (typeof clientId !== "string" || clientId === "") {
    throw new Error(`Client #${index} needs a non-empty client_id`);
  }
  const label = `Client ${JSON.stringify(clientId)}`;

  const redirectUris = stringArray(raw.redirect_uris, `${label} redirect_uris`);
  if (redirectUris.length === 0) {
    throw new Error(`${label} needs at least one entry in redirect_uris`);
  }
  for (const uri of redirectUris) checkRedirectUri(uri, `${label} redirect_uris`);

  const client: ClientConfig = { client_id: clientId, redirect_uris: redirectUris };

  if (raw.client_name !== undefined) {
    if (typeof raw.client_name !== "string" || raw.client_name === "") {
      throw new Error(`${label} client_name must be a non-empty string`);
    }
    client.client_name = raw.client_name;
  }

  if (raw.post_logout_redirect_uris !== undefined) {
    const uris = stringArray(raw.post_logout_redirect_uris, `${label} post_logout_redirect_uris`);
    for (const uri of uris) checkRedirectUri(uri, `${label} post_logout_redirect_uris`);
    client.post_logout_redirect_uris = uris;
  }

  const method = raw.token_endpoint_auth_method;
  if (method !== undefined) {
    if (typeof method !== "string" || !AUTH_METHODS.includes(method)) {
      throw new Error(
        `${label} token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
      );
    }
    client.token_endpoint_auth_method = method as NonNullable<
      ClientConfig["token_endpoint_auth_method"]
    >;
  }

  if (raw.client_secret !== undefined) {
    if (typeof raw.client_secret !== "string" || raw.client_secret === "") {
      throw new Error(`${label} client_secret must be a non-empty string`);
    }
    client.client_secret = raw.client_secret;
  }
  if (client.token_endpoint_auth_method !== "none" && client.client_secret === undefined) {
    throw new Error(
      `${label} is confidential and needs a client_secret (or token_endpoint_auth_method "none")`,
    );
  }

  return client;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function checkRedirectUri(uri: string, label: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`${label}: ${JSON.stringify(uri)} is not a valid URL`);
  }
  const loopbackHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(
      `${label}: redirect URI ${JSON.stringify(uri)} must be https (http only for localhost or 127.0.0.1)`,
    );
  }
}
