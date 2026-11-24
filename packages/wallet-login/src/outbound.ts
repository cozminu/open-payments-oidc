import dns from "node:dns";
import { BlockList, isIP } from "node:net";

export type OutboundPolicyOptions = {
  /** Local development only: allows http everywhere and skips the public-host check. */
  allowHttp: boolean;
  /** Origins of the auth servers we have a client key arrangement with. Paths are ignored. */
  authServerOrigins: readonly string[];
  lookup?: typeof dns.promises.lookup;
};

export type WalletAddressResolution =
  | { kind: "allowed"; url: string }
  | { kind: "unparseable" }
  | { kind: "unreachable"; url: string; error: string };

/**
 * Which hosts the provider may contact, and over which scheme. The one place that knows what
 * `allowHttp` relaxes.
 */
export class OutboundPolicy {
  /** Local development only: http is allowed everywhere and the public-host check is skipped. */
  readonly allowHttp: boolean;
  private readonly authServerOrigins: ReadonlySet<string>;
  private readonly lookup: typeof dns.promises.lookup;

  constructor(options: OutboundPolicyOptions) {
    this.allowHttp = options.allowHttp;
    this.authServerOrigins = new Set(
      options.authServerOrigins.map((origin) => new URL(origin).origin),
    );
    this.lookup = options.lookup ?? dns.promises.lookup;
  }

  /**
   * Turns what the user typed into a wallet address URL we may fetch: https (http only when
   * `allowHttp`), no credentials, and a host that resolves only to public addresses. Never throws.
   */
  async resolveWalletAddress(raw: string): Promise<WalletAddressResolution> {
    const url = toWalletAddressUrl(raw, this.allowHttp);
    if (url === undefined) return { kind: "unparseable" };
    // Without allowHttp this is a friendly early refusal, not the only line of defence.
    if (this.allowHttp) return { kind: "allowed", url };
    try {
      await assertPublicHost(url, this.lookup);
    } catch (error) {
      return {
        kind: "unreachable",
        url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { kind: "allowed", url };
  }

  /** May we send a credential (signed request, continue token, access token) to this URL? */
  allowsCredentialTarget(raw: string): boolean {
    return this.hasAllowedScheme(raw) && this.authServerOrigins.has(new URL(raw).origin);
  }

  /** May we send the user's browser to this URL? */
  allowsBrowserRedirect(raw: string): boolean {
    return this.hasAllowedScheme(raw);
  }

  private hasAllowedScheme(raw: string): boolean {
    if (!URL.canParse(raw)) return false;
    const { protocol } = new URL(raw);
    return protocol === "https:" || (this.allowHttp && protocol === "http:");
  }
}

/** `$wallet.example/alice` style payment pointers; the docs and test wallet still show them. */
const PAYMENT_POINTER = /^\$(?<rest>[^\s/]+(?:\/\S*)?)$/;

function toWalletAddressUrl(raw: string, allowHttp: boolean): string | undefined {
  const trimmed = raw.trim();
  const rest = PAYMENT_POINTER.exec(trimmed)?.groups?.rest;
  const candidate = rest === undefined ? trimmed : `https://${rest}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return url.href;
  return undefined;
}

const NON_PUBLIC = new BlockList();
const IPV4_RANGES: [string, number][] = [
  ["0.0.0.0", 8], // "this network", includes unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
];
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are checked against the IPv4 ranges by BlockList itself.
const IPV6_RANGES: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64, can embed a private IPv4
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];
for (const [address, prefix] of IPV4_RANGES) NON_PUBLIC.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of IPV6_RANGES) NON_PUBLIC.addSubnet(address, prefix, "ipv6");

function isNonPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address we understand: refuse
  return NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Throws unless every address the host resolves to is public. */
async function assertPublicHost(url: string, lookup: typeof dns.promises.lookup): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error("host did not resolve to any address");
  }
  if (addresses.some(({ address }) => isNonPublic(address))) {
    throw new Error("host resolves to a non-public address");
  }
}
