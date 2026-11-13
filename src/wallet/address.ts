import dns from "node:dns";
import { BlockList, isIP } from "node:net";

/** `$wallet.example/alice` style payment pointers; the docs and test wallet still show them. */
const PAYMENT_POINTER = /^\$(?<rest>[^\s/]+(?:\/\S*)?)$/;

/** Turns what the user typed into an https wallet address URL (http only when `allowHttp`). */
export function toWalletAddressUrl(raw: string, allowHttp: boolean): string | undefined {
  const trimmed = raw.trim();
  const rest = PAYMENT_POINTER.exec(trimmed)?.groups?.rest;
  const candidate = rest === undefined ? trimmed : `https://${rest}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return url.href;
  return undefined;
}

/** Auth server origins we have a client key arrangement with. Paths are ignored on purpose. */
export class AuthServerAllowlist {
  private readonly origins: Set<string>;

  constructor(origins: string[]) {
    this.origins = new Set(origins.map((origin) => new URL(origin).origin));
  }

  allows(authServerUrl: string): boolean {
    return URL.canParse(authServerUrl) && this.origins.has(new URL(authServerUrl).origin);
  }
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

/** Throws unless every address the host resolves to is public. Run before fetching a user-supplied wallet address. */
export async function assertPublicHost(
  url: string,
  lookup: typeof dns.promises.lookup = dns.promises.lookup,
): Promise<void> {
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
