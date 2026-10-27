import assert from "node:assert/strict";
import test from "node:test";
import { bareHost, sameSite, tenantOf } from "../src/lib/site-identity.ts";
import { fetchSameSite } from "../src/lib/safe-fetch.ts";
import { findFeeds } from "../src/lib/feed-finder.ts";
import { upgradeTarget } from "../src/lib/feed-upgrade.ts";

// Reviews of the route-audit commits (3 Oct) found that "the same site" was decided three different ways: the
// feed check used a hand-kept list of shared platforms, the redirect gate used a registrable-domain guess, and
// neither normalised the host. These pin the one definition they now share.
const url = (value) => new URL(value);
const same = (a, b) => sameSite(url(a), url(b));

test("a host is the same host however it is written", () => {
  assert.equal(same("https://lab.test./blog", "https://LAB.test/feed.xml"), true, "a trailing dot and capitals change nothing");
  assert.equal(same("https://www.lab.test/", "https://lab.test/"), true);
  assert.equal(same("https://a.github.io./", "https://a.github.io/feed.xml"), true);
  assert.equal(same("https://a.github.io./", "https://b.github.io./feed.xml"), false, "a trailing dot must not merge two tenants");
  assert.equal(same("https://a.substack.com./", "https://b.substack.com./feed"), false);
  assert.equal(same("https://a。github。io/", "https://a.github.io/"), true, "the URL parser's own spelling of a dot is not a second host");
});

test("an address is only itself", () => {
  assert.equal(same("https://1.2.3.4/", "https://9.9.3.4/"), false, "two addresses sharing their last octets are two machines");
  assert.equal(same("https://1.2.3.4/a", "https://1.2.3.4/b"), true);
  assert.equal(same("https://[2606:4700::1]/", "https://[2606:4700::2]/"), false);
  assert.equal(same("https://[2606:4700::1]/a", "https://[2606:4700::1]/b"), true);
});

test("a platform that gives each tenant a subdomain is not one site, whether or not we have heard of it", () => {
  // In the Public Suffix List's private section, so every tenant is its own site.
  for (const platform of ["github.io", "gitlab.io", "hf.space", "readthedocs.io", "workers.dev", "pages.dev", "vercel.app", "netlify.app", "blogspot.com", "notion.site", "webflow.io", "herokuapp.com", "fly.dev", "streamlit.app", "gitbook.io"]) {
    assert.equal(same(`https://a.${platform}/`, `https://a.${platform}/feed.xml`), true, `${platform}: one tenant`);
    assert.equal(same(`https://a.${platform}/`, `https://b.${platform}/feed.xml`), false, `${platform}: two tenants`);
    assert.equal(same(`https://a.${platform}/`, `https://x.a.${platform}/feed.xml`), true, `${platform}: a tenant's own subdomain`);
    assert.equal(same(`https://${platform}/`, `https://a.${platform}/`), false, `${platform}: the platform is not a tenant`);
  }
  // Not in the list, so named here.
  for (const platform of ["substack.com", "medium.com", "ghost.io", "tumblr.com", "wordpress.com", "beehiiv.com", "mintlify.app", "hashnode.dev", "typepad.com", "squarespace.com"]) {
    assert.equal(same(`https://a.${platform}/`, `https://a.${platform}/feed`), true, `${platform}: one tenant`);
    assert.equal(same(`https://a.${platform}/`, `https://b.${platform}/feed`), false, `${platform}: two tenants`);
  }
  assert.equal(same("https://a.run.app/", "https://b.run.app/"), false, "a name that is itself a public suffix names no tenant");
});

test("a registrable domain follows the Public Suffix List, not a guess about two-part endings", () => {
  assert.equal(same("https://a.or.jp/", "https://b.or.jp/feed.xml"), false);
  assert.equal(same("https://a.ltd.uk/", "https://b.ltd.uk/feed.xml"), false);
  assert.equal(same("https://a.com.au/", "https://b.com.au/feed.xml"), false);
  assert.equal(same("https://blog.a.co.uk/", "https://a.co.uk/feed.xml"), true);
  assert.equal(same("https://docs.factory.ai/", "https://www.factory.ai/feed"), true);
});

test("a platform that separates tenants by path is read by path, however the page is reached", () => {
  assert.equal(same("https://www.youtube.com/@a", "https://www.youtube.com/@b"), false);
  assert.equal(same("https://www.youtube.com/@a/videos", "https://m.youtube.com/@a"), true);
  assert.equal(same("https://www.youtube.com/channel/UC1/videos", "https://www.youtube.com/channel/UC2"), false);
  assert.equal(same("https://gitlab.com/a/x", "https://gitlab.com/b/y"), false);
  assert.equal(same("https://gitlab.com/a/x", "https://gitlab.com/a/y"), true, "two projects of one owner");
  assert.equal(same("https://www.reddit.com/r/a/", "https://www.reddit.com/r/b/.rss"), false);
  assert.equal(same("https://old.reddit.com/r/a", "https://reddit.com/r/a/.rss"), true);
  assert.equal(same("https://medium.com/%40acme", "https://medium.com/feed/@acme"), true, "an escaped @ is the same author");
  assert.equal(same("https://medium.com/@acme/post-1", "https://acme.medium.com/post-1"), true, "Medium serves one author at both addresses");
  assert.equal(same("https://medium.com/@acme/post-1", "https://other.medium.com/post-1"), false);
  assert.equal(same("https://medium.com/", "https://medium.com/"), false, "a platform page has no tenant, so it vouches for nothing");
  assert.equal(same("https://medium.com/p/1a2b3c", "https://medium.com/p/9z8y7x"), false, "nor does a post addressed by number");
});

test("Hugging Face is many publishers: its own pages, each organisation's, and each user's", () => {
  assert.equal(same("https://huggingface.co/blog/smolagents", "https://huggingface.co/docs/transformers/index"), true, "HF's own blog and documentation");
  assert.equal(same("https://huggingface.co/blog/smolagents", "https://huggingface.co/papers/2501.00001"), true);
  assert.equal(same("https://huggingface.co/blog/smolagents", "https://huggingface.co/some-user/their-model"), false, "a user's model is not HF's");
  assert.equal(same("https://huggingface.co/blog/smolagents", "https://huggingface.co/spaces/some-user/app"), false, "nor is a user's space");
  assert.equal(same("https://huggingface.co/blog/meta-llama/llama-4", "https://huggingface.co/meta-llama/Llama-4"), true, "an organisation's post and its model");
  assert.equal(same("https://huggingface.co/blog/meta-llama/llama-4", "https://huggingface.co/blog/some-user/their-post"), false, "two authors on the same blog");
  assert.equal(same("https://huggingface.co/spaces/some-user/app", "https://huggingface.co/some-user/their-model"), true, "one user's space and model");
  assert.equal(same("https://huggingface.co/datasets/some-user/data", "https://huggingface.co/collections/some-user/mine"), true);
  assert.equal(same("https://huggingface.co/posts/some-user/123", "https://huggingface.co/some-user/their-model"), true);
  assert.equal(same("https://huggingface.co/posts/some-user/123", "https://huggingface.co/posts/other-user/456"), false);
  assert.equal(same("https://huggingface.co/some-user/a", "https://huggingface.co/other-user/b"), false);
  // Only the Hub has owners in its paths; the forum, the status page and the rest are the company's own, whatever their paths.
  assert.equal(same("https://discuss.huggingface.co/c/models/13", "https://discuss.huggingface.co/posts.rss"), true, "forum category pages are not owners");
  assert.equal(same("https://discuss.huggingface.co/t/question/1", "https://huggingface.co/blog/smolagents"), true, "and the forum is the company's, as before");
  assert.equal(same("https://www.huggingface.co/some-user/a", "https://huggingface.co/some-user/b"), true, "the www host is the Hub");
  assert.equal(same("https://www.huggingface.co/some-user/a", "https://huggingface.co/other-user/b"), false);
  assert.equal(same("https://huggingface.co/blog/some-user/post", "https://huggingface.co/some-user/model"), true, "a community post and its author's model are the author's");
});

test("an aggregator is never trusted by address", () => {
  assert.equal(tenantOf(url("https://feeds.feedburner.com/a")), null);
  assert.equal(tenantOf(url("https://feedproxy.google.com/~r/a")), null);
  assert.equal(same("https://lab.test/blog", "https://feeds.feedblitz.com/lab"), false);
});

// A second review (3 Oct) of the module itself: a validator that the URL parser re-reads, an identity that ignored the
// port, a case fold wider than ASCII, and the question of what a second hostname parser inside the Public Suffix List
// library makes of text a name cannot contain.
test("a bare host name is only accepted when the URL parser reads it as the same name", () => {
  for (const value of ["0x7f.1", "2130706433", "1.2.3", "127.1", "10.0.0.1", "lab test", "lab.test/x", "lab.test:8443", "user@lab.test", "-lab.test", "lab.test.", ""]) assert.equal(bareHost(value), null, `[${value}]`);
  assert.equal(bareHost("LAB.test")?.hostname, "lab.test");
  assert.equal(bareHost("docs.factory.com")?.hostname, "docs.factory.com");
});

test("a port is part of whose a page is", () => {
  assert.equal(same("https://lab.test/", "https://lab.test:8443/feed"), false, "another port is another service");
  assert.equal(same("https://a.github.io/", "https://a.github.io:8443/"), false);
  assert.equal(same("https://lab.test:8443/blog", "https://blog.lab.test:8443/feed"), true, "the same service, another subdomain");
  assert.equal(same("https://lab.test/", "https://lab.test:443/feed"), true, "the default port written out is no port");
});

test("a path tenant folds ASCII capitals only, so a look-alike letter is not the same author", () => {
  assert.equal(same("https://medium.com/@Kyle", "https://medium.com/@kyle"), true);
  assert.equal(same("https://medium.com/@kyle", "https://medium.com/@\u212Ayle"), false, "the Kelvin sign lower-cases to k, but it is not one");
  assert.equal(same("https://medium.com/feed/feed/@a", "https://medium.com/feed/feed/@b"), false, "one feed prefix is skipped, not any number");
  assert.equal(same("https://www.reddit.com/r/\u0130a", "https://www.reddit.com/r/ia"), false);
});

test("spelling a host differently never changes whose it is, and never merges two tenants", () => {
  const spellings = {
    "upper case": (host) => host.toUpperCase(), "a trailing dot": (host) => `${host}.`, "two trailing dots": (host) => `${host}..`,
    "a percent-encoded letter": (host) => host.replace(/^./, (letter) => `%${letter.charCodeAt(0).toString(16)}`), "a soft hyphen": (host) => host.replace(/\./, "\u00AD."),
    "a full-width dot": (host) => host.replace(/\./g, "\u3002"), "the default port": (host) => `${host}:443`, "credentials": (host) => `user:secret@${host}`,
  };
  for (const [name, spell] of Object.entries(spellings)) {
    for (const host of ["acme.github.io", "blog.lab.test", "acme.substack.com", "www.youtube.com", "medium.com"]) {
      assert.equal(tenantOf(url(`https://${spell(host)}/@acme`)), tenantOf(url(`https://${host}/@acme`)), `${name} on ${host}`);
    }
    assert.equal(same(`https://${spell("a.github.io")}/`, `https://${spell("b.github.io")}/`), false, `${name} must not merge two github.io tenants`);
  }
});

test("a host name with characters a name cannot have is only itself, never a part of another site", () => {
  for (const odd of ["a.github.io;x.evil.com", "a.github.io!.evil.com", "a.github.io,b.github.io", "a.github.io'.b.github.io"]) {
    assert.equal(tenantOf(url(`https://${odd}/`)), odd, odd);
    assert.equal(same(`https://${odd}/`, "https://a.github.io/"), false, odd);
    assert.equal(same(`https://${odd}/`, "https://evil.com/"), false, odd);
    assert.equal(same(`https://${odd}/`, "https://b.github.io/"), false, `${odd}: the library's unvalidated mode reads a suffix out of such text`);
  }
  assert.equal(same("https://a_b.github.io/", "https://a_b.github.io/feed"), true, "an underscore is a legal label character");
  assert.equal(same("https://a_b.github.io/", "https://a_c.github.io/feed"), false);
});

const respond = (pages, requested = []) => async (target) => {
  requested.push(target);
  const page = pages[target];
  if (page === undefined) return new Response("missing", { status: 404 });
  if (page.redirect) return new Response(null, { status: 302, headers: { location: page.redirect } });
  return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
};

test("a redirect may only stay with the tenant, and the next address is not even requested", async () => {
  const requested = [];
  const fetcher = respond({
    "https://a.substack.com/post": { redirect: "https://b.substack.com/post" }, "https://b.substack.com/post": "<p>someone else</p>",
    "https://a.github.io/post": { redirect: "https://b.github.io./post" }, "https://b.github.io./post": "<p>someone else</p>",
    "https://lab.test/post": { redirect: "https://www.lab.test/post" }, "https://www.lab.test/post": "<p>ours</p>",
    "https://acme.medium.com/post": { redirect: "https://acme.medium.com/post-2" }, "https://acme.medium.com/post-2": "<p>ours</p>",
  }, requested);
  assert.equal(await fetchSameSite("https://a.substack.com/post", { fetcher }), null);
  assert.equal(await fetchSameSite("https://a.github.io/post", { fetcher }), null);
  assert.ok(!requested.some((target) => /b\.(substack\.com|github\.io)/.test(target)), "the other tenant is never contacted");
  assert.equal((await fetchSameSite("https://lab.test/post", { fetcher }))?.url, "https://www.lab.test/post");
  assert.equal((await fetchSameSite("https://acme.medium.com/post", { fetcher }))?.url, "https://acme.medium.com/post-2");
});

test("a publisher that moved can name where its pages now live", async () => {
  const fetcher = respond({ "https://docs.old.test/": { redirect: "https://docs.new.test/" }, "https://docs.new.test/": "<p>moved</p>" });
  assert.equal(await fetchSameSite("https://docs.old.test/", { fetcher }), null);
  assert.equal((await fetchSameSite("https://docs.old.test/", { fetcher, trustedHosts: ["new.test"] }))?.url, "https://docs.new.test/");
  assert.equal(await fetchSameSite("https://docs.old.test/", { fetcher, trustedHosts: ["elsewhere.test/x@new.test", "not a host"] }), null, "a trusted host is a bare host name");
});

const rss = (title) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>${title}</title><pubDate>Tue, 23 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
const now = new Date("2026-09-24T12:00:00Z");

test("a feed that redirects to another tenant is not the publisher's feed", async () => {
  const requested = [];
  const fetcher = respond({
    "https://a.substack.com/": `<head><link rel="alternate" type="application/rss+xml" href="/feed"></head>`,
    "https://a.substack.com/feed": { redirect: "https://b.substack.com/feed" },
    "https://b.substack.com/feed": rss("Somebody else's post about LLM agents"),
    "https://a.substack.com/rss.xml": rss("Our own post about LLM agents"),
  }, requested);
  const feeds = await findFeeds("a.substack.com", { fetcher, now });
  assert.deepEqual(feeds.map((feed) => feed.url), ["https://a.substack.com/rss.xml"]);
  assert.ok(!requested.includes("https://b.substack.com/feed"));
});

test("only a feed the page really advertises is followed, not markup inside a comment or a script", async () => {
  const fetcher = respond({
    "https://lab.test/": `<html><head><link rel="alternate" type="application/rss+xml" href="/real.xml"></head><body>
      <!-- <link rel="alternate" type="application/rss+xml" href="/commented.xml"> -->
      <script>var tag = '<link rel="alternate" type="application/rss+xml" href="/scripted.xml">';</script></body></html>`,
    "https://lab.test/real.xml": rss("A real post about LLM agents"),
    "https://lab.test/commented.xml": rss("A commented-out post about LLM agents"),
    "https://lab.test/scripted.xml": rss("A scripted post about LLM agents"),
  });
  const feeds = await findFeeds("lab.test", { fetcher, now });
  assert.deepEqual(feeds.map((feed) => feed.url), ["https://lab.test/real.xml"]);
});

test("a route is only upgraded to an https feed of its own tenant, written plainly", () => {
  assert.equal(upgradeTarget("https://a.github.io./blog", "https://b.github.io./feed.xml"), null);
  assert.equal(upgradeTarget("https://a.gitlab.io/blog", "https://b.gitlab.io/feed.xml"), null);
  assert.equal(upgradeTarget("https://lab.test/blog", "http://lab.test/feed.xml"), null, "https only");
  assert.equal(upgradeTarget("https://lab.test/blog", "https://user:secret@lab.test/feed.xml"), null, "no credentials in a feed address");
  assert.equal(upgradeTarget("https://lab.test/blog", "https://evil.test/feed.xml", "evil.test/x@lab.test"), null, "the catalog's owner host is a bare host name");
  assert.equal(upgradeTarget("https://docs.old.test/blog", "https://docs.new.test/blog/rss.xml", "new.test"), "https://docs.new.test/blog/rss.xml");
  assert.equal(upgradeTarget("https://lab.test/blog", "https://lab.test/blog/rss.xml"), "https://lab.test/blog/rss.xml");
});
