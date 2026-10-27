/**
 * Who a request is counted as. The caller is its address, or for IPv6 its /64, since one caller holds a whole /64 and could otherwise take
 * a new address for every request; an IPv4-mapped address is the IPv4 one. An IPv6 caller is also counted by its network, its /48, which is
 * one customer however many /64s it rotates through. An IPv4 address has no network, since unrelated hosts share a /24. What cannot be read
 * is kept as it is, not guessed at.
 */
export function whoIs(request: Request): { caller: string; network: string | null } {
  const ip = (request.headers.get("cf-connecting-ip") ?? "").toLowerCase();
  if (!ip) return { caller: "anonymous", network: null };
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)?.[1];
  if (mapped) return { caller: mapped, network: null };
  if (!ip.includes(":")) return { caller: ip, network: null };
  const halves = ip.split("::");
  if (halves.length > 2) return { caller: ip, network: null };
  const [head, tail = ""] = halves;
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return { caller: ip, network: null };
  const value = groups.map((group) => parseInt(group, 16));
  // An IPv4-mapped address written in hex is the same one: left as an IPv6 address it would put every mapped caller in one /64.
  if (value.slice(0, 5).every((group) => group === 0) && value[5] === 0xffff) return { caller: `${value[6] >> 8}.${value[6] & 255}.${value[7] >> 8}.${value[7] & 255}`, network: null };
  const prefix = (count: number) => value.slice(0, count).map((group) => group.toString(16)).join(":");
  return { caller: `${prefix(4)}::/64`, network: `${prefix(3)}::/48` };
}
