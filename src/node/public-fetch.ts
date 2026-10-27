import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";
import { canonicalSourceUrl, PAGE_HEADERS, type PageResponse } from "../lib/source-evidence.js";
import { decodeBody } from "../lib/body-text.js";

// Node has no network isolation, so every connection (including each redirect) is
// checked against private and reserved address ranges before it is made.
let addressLists: { ipv4: BlockList; ipv6: BlockList; publicV6: BlockList } | undefined;
function getAddressLists() {
  if (addressLists) return addressLists;
  const ipv4 = new BlockList(), ipv6 = new BlockList(), publicV6 = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["192.88.99.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
  ] as const) ipv4.addSubnet(address, prefix, "ipv4");
  for (const [address, prefix] of [
    ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
    ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
    ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ] as const) ipv6.addSubnet(address, prefix, "ipv6");
  publicV6.addSubnet("2000::", 3, "ipv6");
  addressLists = { ipv4, ipv6, publicV6 };
  return addressLists;
}

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  const { ipv4, ipv6, publicV6 } = getAddressLists();
  if (!family || (family === 4 && ipv4.check(address, "ipv4"))
    || (family === 6 && (!publicV6.check(address, "ipv6") || ipv6.check(address, "ipv6")))) {
    throw new Error("Evidence URL resolves to a private or reserved address.");
  }
}


// DNS validation runs inside the connection lookup, including every redirect.
export async function publicPageLoader(value: string, signal?: AbortSignal, maxBytes = 5_000_000): Promise<PageResponse> {
  const url = new URL(canonicalSourceUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) assertPublicAddress(host);
  const dispatcher = new Agent({ connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) { callback(error, "", 0); return; }
        try { addresses.forEach(({ address }) => assertPublicAddress(address)); }
        catch (error) { callback(error instanceof Error ? error : new Error(String(error)), "", 0); return; }
        const available = addresses.filter((row) => !options.family || row.family === options.family);
        if (!available.length) { callback(new Error("No public address in the requested family"), "", 0); return; }
        if (options.all) callback(null, available);
        else callback(null, available[0].address, available[0].family);
      });
    },
  } });
  try {
    const timeout = AbortSignal.timeout(30_000);
    // Use the same public-page transport and negotiation as the research tool.
    // Redirects are handled by fetchSourceDocument so every destination is checked.
    const response = await fetch(url, {
      dispatcher, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: PAGE_HEADERS,
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Source exceeds ${maxBytes / 1_000_000} MB capture limit`);
      chunks.push(chunk);
    }
    const contentType = response.headers.get("content-type") ?? "";
    return { status: response.status, location: response.headers.get("location") ?? undefined, contentType, body: decodeBody(Buffer.concat(chunks), contentType) };
  } finally { await dispatcher.close(); }
}
