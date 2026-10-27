import assert from "node:assert/strict";
import test from "node:test";
import { resolveArticle } from "../src/lib/resolve-items.ts";

// An index page is untrusted input: its links decide where the collector fetches next. A same-site
// link must not become a way to reach internal addresses, and a slow site must not hold a run.

const html = (date) => `<html><head><meta property="article:published_time" content="${date}"><meta property="og:type" content="article"></head><body><main>${"text ".repeat(50)}</main></body></html>`;
const now = new Date("2026-10-03T12:00:00Z");
const page = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });
const options = (fetcher) => ({ fetcher, now, indexBody: "<index>" });

test("a redirect inside the same site is followed, a limited number of times", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init?.redirect]);
    if (url === "https://lab.test/blog/old-slug") return redirect("https://www.lab.test/blog/new-slug");
    if (url === "https://www.lab.test/blog/new-slug") return page(html("2026-10-02T10:00:00Z"));
    return page("", 404);
  };
  const result = await resolveArticle("https://lab.test/blog/old-slug", options(fetcher));
  assert.equal(result.publishedAt, "2026-10-02T10:00:00.000Z");
  assert.ok(calls.every(([, mode]) => mode === "manual"), "redirects are handled here, never by the platform");
  const loop = async (url) => redirect(`${url}x`);
  assert.equal(await resolveArticle("https://lab.test/blog/loop", options(loop)), null);
});

test("a redirect to an internal address, another scheme, another port or another site is not followed", async () => {
  for (const target of ["http://169.254.169.254/latest/meta-data/", "https://169.254.169.254/x", "https://localhost/admin", "https://127.0.0.1:8443/x", "https://[::1]/x", "ftp://lab.test/x",
    "https://lab.test:8443/x", "https://user:pass@lab.test/x", "https://elsewhere.example/blog/post", "file:///etc/passwd"]) {
    const requested = [];
    const fetcher = async (url) => { requested.push(url); return url === "https://lab.test/blog/post" ? redirect(target) : page(html("2026-10-02T10:00:00Z")); };
    assert.equal(await resolveArticle("https://lab.test/blog/post", options(fetcher)), null, target);
    assert.deepEqual(requested, ["https://lab.test/blog/post"], `${target} was never requested`);
  }
});

import { isPublicHostName, setDefaultPageLoader } from "../src/lib/source-evidence.ts";
import { fetchSameSite } from "../src/lib/safe-fetch.ts";

test("only a real public host name is accepted: no literals, bare labels, trailing dots or internal suffixes", () => {
  for (const host of ["lab.test", "www.runway.com", "blog.google", "a.b.example.org", "xn--80ak6aa92e.com"]) assert.equal(isPublicHostName(host), true, host);
  for (const host of ["localhost", "localhost.", "foo.localhost", "intranet.local", "metadata.google.internal", "printer.lan", "router.home.arpa", "host.localdomain", "corp.intranet",
    "127.0.0.1", "10.0.0.5", "[::1]", "[::ffff:7f00:1]", "singlelabel", "lab.test.", "", "x.onion"]) assert.equal(isPublicHostName(host), false, host);
});

test("a first URL that is not a public host is never requested", async () => {
  for (const url of ["https://localhost./x", "https://foo.localhost/x", "https://intranet.local/x", "https://metadata.google.internal/x", "https://127.0.0.1/x", "https://2130706433/x", "https://[::1]/x", "http://lab.test/x"]) {
    let requested = 0;
    assert.equal(await resolveArticle(url, options(async () => { requested++; return page(html("2026-10-02T10:00:00Z")); })), null, url);
    assert.equal(requested, 0, url);
  }
});

test("the whole fetch has one deadline, even when the fetcher ignores its abort signal", async () => {
  const started = Date.now();
  const hang = () => new Promise(() => {});
  assert.equal(await fetchSameSite("https://lab.test/blog/post", { fetcher: hang, timeoutMs: 60 }), null);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
  // Redirect hops share the deadline: three slow hops do not get three timeouts.
  const slowHops = async (url) => { await new Promise((resolve) => setTimeout(resolve, 40)); return redirect(`${url}x`); };
  const hopsStarted = Date.now();
  assert.equal(await fetchSameSite("https://lab.test/blog/p", { fetcher: slowHops, timeoutMs: 60 }), null);
  assert.ok(Date.now() - hopsStarted < 400, `took ${Date.now() - hopsStarted}ms`);
});

test("by default a page is read through the installed page loader, so Node's DNS check applies to every hop", async () => {
  const seen = [];
  setDefaultPageLoader(async (url) => {
    seen.push(url);
    if (url === "https://lab.test/blog/old") return { status: 302, location: "https://lab.test/blog/new", contentType: "text/html", body: "" };
    if (url === "https://lab.test/blog/new") return { status: 200, contentType: "text/html; charset=utf-8", body: html("2026-10-02T10:00:00Z") };
    if (url === "https://lab.test/blog/away") return { status: 302, location: "https://169.254.169.254/latest", contentType: "", body: "" };
    return { status: 404, contentType: "", body: "" };
  });
  try {
    const result = await resolveArticle("https://lab.test/blog/old", { now, indexBody: "<index>" });
    assert.equal(result.publishedAt, "2026-10-02T10:00:00.000Z");
    assert.deepEqual(seen, ["https://lab.test/blog/old", "https://lab.test/blog/new"]);
    seen.length = 0;
    assert.equal(await resolveArticle("https://lab.test/blog/away", { now, indexBody: "<index>" }), null);
    assert.deepEqual(seen, ["https://lab.test/blog/away"], "the internal address is never requested");
  } finally { setDefaultPageLoader(null); }
});

test("once the deadline has passed no further hop is requested, even by a fetcher that ignores abort", async () => {
  let calls = 0;
  const slowRedirect = async (url) => { calls++; await new Promise((resolve) => setTimeout(resolve, 80)); return redirect(`${url}x`); };
  assert.equal(await fetchSameSite("https://lab.test/blog/p", { fetcher: slowRedirect, timeoutMs: 30 }), null);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls, 1, "the redirect that arrives after the deadline is not followed");
});

test("the size cap goes to the loader, so a page is cut off while it is read, not after", async () => {
  const caps = [];
  setDefaultPageLoader(async (url, signal, maxBytes) => { caps.push(maxBytes); return { status: 200, contentType: "text/html", body: html("2026-10-02T10:00:00Z") }; });
  try {
    await resolveArticle("https://lab.test/blog/post", { now, indexBody: "<index>" });
    await fetchSameSite("https://lab.test/blog/post", { maxBytes: 12_345 });
    assert.deepEqual(caps, [2_000_000, 12_345]);
    // A loader that ignores the cap is still refused afterwards.
    setDefaultPageLoader(async () => ({ status: 200, contentType: "text/html", body: "x".repeat(2_000)}));
    assert.equal(await fetchSameSite("https://lab.test/blog/post", { maxBytes: 1_000 }), null);
  } finally { setDefaultPageLoader(null); }
});
