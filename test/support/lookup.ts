import type dns from "node:dns";

export type Lookup = typeof dns.promises.lookup;

/** A public IPv4 address (example.com) for lookups that should pass the host check. */
export const PUBLIC_ADDRESS = "93.184.216.34";

/** A `dns.promises.lookup` that answers every name with `addresses`, recording the names asked. */
export function stubLookup(...addresses: string[]): Lookup & { hostnames: string[] } {
  const hostnames: string[] = [];
  const stub = async (hostname: string) => {
    hostnames.push(hostname);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(stub as unknown as Lookup, { hostnames });
}

/** A lookup that fails like an unknown name does. */
export const failingLookup = (async () => {
  throw new Error("ENOTFOUND");
}) as unknown as Lookup;
