import assert from "node:assert/strict";
import test from "node:test";
import { whoIs } from "../src/lib/caller.ts";

// Who a request is counted as by a limiter: its address, or for IPv6 its /64 and its /48, since one caller holds a whole /64 and a customer
// a /48, and either could otherwise take a new address for every request.
const of = (ip) => whoIs(new Request("https://api.test/", ip === undefined ? {} : { headers: { "cf-connecting-ip": ip } }));

test("an IPv4 address is the caller, with no network, and a request with no address is one anonymous caller", () => {
  assert.deepEqual(of("203.0.113.7"), { caller: "203.0.113.7", network: null });
  assert.deepEqual(of("  203.0.113.7 "), { caller: "203.0.113.7", network: null });
  assert.deepEqual(of(undefined), { caller: "anonymous", network: null });
  assert.deepEqual(of(""), { caller: "anonymous", network: null });
  assert.deepEqual(of("::ffff:203.0.113.7"), { caller: "203.0.113.7", network: null }, "an IPv4-mapped address is the IPv4 one");
  for (const hex of ["::ffff:cb00:7107", "0:0:0:0:0:ffff:cb00:7107", "::FFFF:CB00:7107"]) assert.deepEqual(of(hex), { caller: "203.0.113.7", network: null }, `${hex}: written in hex it is the same one, not every mapped address at once`);
  assert.deepEqual(of("::ffff:0:0"), { caller: "0.0.0.0", network: null });
});

test("an IPv6 address is counted by its /64, and by its /48 as the network", () => {
  assert.deepEqual(of("2001:db8:1234:5678::1"), { caller: "2001:db8:1234:5678::/64", network: "2001:db8:1234::/48" });
  for (const same of ["2001:DB8:1234:5678:aaaa:bbbb:cccc:dddd", "2001:0db8:1234:5678:0:0:0:2", "2001:db8:1234:5678::"]) assert.equal(of(same).caller, "2001:db8:1234:5678::/64", same);
  assert.notEqual(of("2001:db8:1234:5679::1").caller, "2001:db8:1234:5678::/64", "another /64 is another caller");
  assert.equal(of("2001:db8:1234:5679::1").network, "2001:db8:1234::/48", "in the same network");
  assert.notEqual(of("2001:db8:1235:5678::1").network, "2001:db8:1234::/48", "another /48 is another network");
  assert.deepEqual(of("::1"), { caller: "0:0:0:0::/64", network: "0:0:0::/48" }, "the loopback, short as it is");
  assert.deepEqual(of("2001:db8::ffff:cb00:7107"), { caller: "2001:db8:0:0::/64", network: "2001:db8:0::/48" }, "only a prefix of zeros makes an address a mapped one");
});

test("what cannot be read is kept as it is, with no network, and not guessed at", () => {
  for (const odd of ["not an address", "garbage:text", "1:2:3:4:5:6:7:8:9", "xyz1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7", "2001:db8::1::2", "1:2:3:4:5:6:7:8::9"]) assert.deepEqual(of(odd), { caller: odd, network: null }, odd);
});
