import { afterEach, describe, expect, test } from "bun:test";
import { GitHubSource, parseRepoRef, readGitHubToken, resetGitHubTokenCache } from "./github.js";
import { parseFeed, RssSource } from "./rss.js";
import { clampNotes, normaliseDate, SourceError, toNewRelease } from "./index.js";

// --- fetch stubbing --------------------------------------------------------
// Sources call global fetch directly, so tests swap it out. Every test that
// does so restores it, otherwise a later test hits the network for real.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGitHubTokenCache();
});

interface StubCall {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(
  responder: (url: string) => { status?: number; body?: string; headers?: Record<string, string> },
): StubCall[] {
  const calls: StubCall[] = [];
  // Explicitly typed so the parameters are contextually typed rather than cast.
  // Bun's `fetch` also carries a `preconnect` method, grafted back on below so
  // the stub satisfies `typeof fetch` without an assertion.
  const handler: (input: string | Request | URL, init?: RequestInit) => Promise<Response> = (
    input,
    init,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({ url, headers });
    const r = responder(url);
    return Promise.resolve(
      new Response(r.status === 304 ? null : (r.body ?? "[]"), {
        status: r.status ?? 200,
        headers: r.headers ?? {},
      }),
    );
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return calls;
}

// --- helpers ---------------------------------------------------------------

describe("normaliseDate", () => {
  test("passes ISO through as UTC", () => {
    expect(normaliseDate("2026-07-06T10:00:00Z")).toBe("2026-07-06T10:00:00.000Z");
  });

  test("converts RFC-822, which RSS feeds use", () => {
    expect(normaliseDate("Mon, 06 Jul 2026 10:00:00 GMT")).toBe("2026-07-06T10:00:00.000Z");
  });

  test("returns null rather than an epoch for junk", () => {
    // A bogus 1970 would pin the release to the bottom of the inbox forever.
    expect(normaliseDate("not a date")).toBeNull();
    expect(normaliseDate(null)).toBeNull();
    expect(normaliseDate("")).toBeNull();
  });
});

describe("clampNotes", () => {
  test("returns null for empty or whitespace bodies", () => {
    expect(clampNotes(null)).toBeNull();
    expect(clampNotes("   \n ")).toBeNull();
  });

  test("keeps short notes verbatim and marks truncation on long ones", () => {
    expect(clampNotes("short")).toBe("short");
    const clamped = clampNotes("x".repeat(50), 10);
    expect(clamped).toStartWith("xxxxxxxxxx");
    expect(clamped).toEndWith("[… truncated]");
  });
});

describe("toNewRelease", () => {
  test("carries the backfilled flag through", () => {
    const fetched = {
      ext_id: "1",
      tag: "v1",
      title: "v1",
      url: "u",
      notes: null,
      published_at: null,
    };
    expect(toNewRelease({ id: 7 }, fetched, true).backfilled).toBe(true);
    expect(toNewRelease({ id: 7 }, fetched, false).app_id).toBe(7);
  });
});

// --- GitHub ----------------------------------------------------------------

describe("parseRepoRef", () => {
  test("accepts a bare owner/repo", () => {
    expect(parseRepoRef("neovim/neovim")).toBe("neovim/neovim");
  });

  test("accepts the releases.atom URLs the Miniflux roster holds", () => {
    // This is the exact shape import-roster.ts will hand it.
    expect(parseRepoRef("https://github.com/neovim/neovim/releases.atom")).toBe("neovim/neovim");
  });

  test("accepts assorted GitHub URL shapes", () => {
    expect(parseRepoRef("https://github.com/cli/cli/releases")).toBe("cli/cli");
    expect(parseRepoRef("https://www.github.com/cli/cli.git")).toBe("cli/cli");
    expect(parseRepoRef("  /cli/cli/  ")).toBe("cli/cli");
  });

  test("rejects anything that isn't owner/repo", () => {
    expect(() => parseRepoRef("neovim")).toThrow(SourceError);
    expect(() => parseRepoRef("")).toThrow(SourceError);
    expect(() => parseRepoRef("https://github.com/")).toThrow(SourceError);
  });
});

const GH_RELEASE = {
  id: 12345,
  tag_name: "v1.2.3",
  name: "Version 1.2.3",
  html_url: "https://github.com/o/r/releases/tag/v1.2.3",
  body: "Fixed things.",
  draft: false,
  prerelease: false,
  published_at: "2026-07-06T10:00:00Z",
};

describe("GitHubSource", () => {
  test("maps a release onto ext_id = release id, not the tag", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ body: JSON.stringify([GH_RELEASE]), headers: { etag: 'W/"a"' } }));

    const result = await source.fetch("o/r", {});
    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('W/"a"');
    expect(result.releases).toHaveLength(1);
    const r = result.releases[0]!;
    expect(r.ext_id).toBe("12345");
    expect(r.tag).toBe("v1.2.3");
    expect(r.title).toBe("Version 1.2.3");
    expect(r.notes).toBe("Fixed things.");
    expect(r.published_at).toBe("2026-07-06T10:00:00.000Z");
  });

  test("sends If-None-Match and reports a 304 without releases", async () => {
    const source = new GitHubSource();
    const calls = stubFetch(() => ({ status: 304 }));

    const result = await source.fetch("o/r", { etag: 'W/"cached"' });
    expect(calls[0]?.headers["if-none-match"]).toBe('W/"cached"');
    expect(result.notModified).toBe(true);
    expect(result.releases).toEqual([]);
    // The stored ETag survives a 304 — the server didn't send a new one.
    expect(result.etag).toBe('W/"cached"');
  });

  test("requests per_page and honours an explicit limit for backfill", async () => {
    const source = new GitHubSource();
    const calls = stubFetch(() => ({ body: "[]" }));
    await source.fetch("o/r", { limit: 5 });
    expect(calls[0]?.url).toContain("per_page=5");
  });

  test("drops drafts but keeps prereleases", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({
      body: JSON.stringify([
        { ...GH_RELEASE, id: 1, draft: true },
        { ...GH_RELEASE, id: 2, prerelease: true },
      ]),
    }));
    const { releases } = await source.fetch("o/r", {});
    expect(releases.map((r) => r.ext_id)).toEqual(["2"]);
  });

  test("falls back to the tag for title and URL when name and html_url are absent", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ body: JSON.stringify([{ id: 9, tag_name: "v2", name: "  " }]) }));
    const { releases } = await source.fetch("o/r", {});
    expect(releases[0]?.title).toBe("v2");
    expect(releases[0]?.url).toBe("https://github.com/o/r/releases/tag/v2");
  });

  test("uses the tag as ext_id when a release somehow has no id", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ body: JSON.stringify([{ tag_name: "v3" }]) }));
    const { releases } = await source.fetch("o/r", {});
    expect(releases[0]?.ext_id).toBe("v3");
  });

  test("drops an entry with neither id nor tag rather than inventing one", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ body: JSON.stringify([{ name: "mystery" }, null, "junk"]) }));
    const { releases } = await source.fetch("o/r", {});
    expect(releases).toEqual([]);
  });

  test("falls back to created_at when a release was never published_at", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({
      body: JSON.stringify([
        { id: 1, tag_name: "v1", published_at: null, created_at: "2026-01-01T00:00:00Z" },
      ]),
    }));
    const { releases } = await source.fetch("o/r", {});
    expect(releases[0]?.published_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("raises SourceError carrying the status on a non-2xx", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ status: 404, body: "{}" }));
    expect(source.fetch("o/r", {})).rejects.toThrow(SourceError);

    // 403 is how the rate limit shows up; the poller logs the status.
    stubFetch(() => ({ status: 403, body: "{}" }));
    const err: unknown = await source.fetch("o/r", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    if (err instanceof SourceError) expect(err.status).toBe(403);
  });

  test("recognises an exhausted rate limit, which arrives as a plain 403", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({
      status: 403,
      body: "{}",
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1785087308" },
    }));

    const err: unknown = await source.fetch("o/r", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    if (err instanceof SourceError) {
      // Without reading the header this is indistinguishable from a private repo.
      expect(err.rateLimited).toBe(true);
      expect(err.message).toContain("rate limit");
      expect(err.message).toContain("2026-07-26");
    }
  });

  test("a 403 with quota remaining is an ordinary per-app failure", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ status: 403, body: "{}", headers: { "x-ratelimit-remaining": "42" } }));

    const err: unknown = await source.fetch("o/r", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    if (err instanceof SourceError) expect(err.rateLimited).toBe(false);
  });

  test("treats a 429 as a rate limit too", async () => {
    const source = new GitHubSource();
    stubFetch(() => ({ status: 429, body: "{}" }));
    const err: unknown = await source.fetch("o/r", {}).catch((e: unknown) => e);
    expect(err instanceof SourceError && err.rateLimited).toBe(true);
  });

  test("raises when the body isn't an array (an error object, say)", () => {
    stubFetch(() => ({ body: JSON.stringify({ message: "Not Found" }) }));
    expect(new GitHubSource().fetch("o/r", {})).rejects.toThrow(SourceError);
  });

  test("sends no Authorization header when no token file exists", async () => {
    const calls = stubFetch(() => ({ body: "[]" }));
    await new GitHubSource().fetch("o/r", {});
    // The "no keys on disk" property: unauthenticated is the normal state.
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(readGitHubToken()).toBeNull();
  });
});

// --- RSS / Atom ------------------------------------------------------------

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>codeberg.org/forgejo/forgejo releases</title>
  <entry>
    <id>https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.1</id>
    <title>v13.0.1</title>
    <updated>2026-07-06T10:00:00Z</updated>
    <link rel="alternate" href="https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.1"/>
    <content type="html">Bug fixes.</content>
  </entry>
  <entry>
    <id>https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.0</id>
    <title>v13.0.0</title>
    <updated>2026-06-01T10:00:00Z</updated>
    <link rel="alternate" href="https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.0"/>
    <content type="html">Big one.</content>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Obsidian Changelog</title>
    <item>
      <title>1.10.2</title>
      <guid>obsidian-1.10.2</guid>
      <link>https://obsidian.md/changelog/2026-07-06-desktop-v1.10.2/</link>
      <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>
      <description>Shiny.</description>
    </item>
  </channel>
</rss>`;

describe("parseFeed", () => {
  test("reads Atom entries", () => {
    const items = parseFeed(ATOM, "feed");
    expect(items).toHaveLength(2);
    const first = items[0]!;
    expect(first.ext_id).toBe("https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.1");
    expect(first.title).toBe("v13.0.1");
    expect(first.tag).toBe("v13.0.1");
    expect(first.url).toBe("https://codeberg.org/forgejo/forgejo/releases/tag/v13.0.1");
    expect(first.notes).toBe("Bug fixes.");
    expect(first.published_at).toBe("2026-07-06T10:00:00.000Z");
  });

  test("reads RSS 2.0 items, including RFC-822 dates", () => {
    const items = parseFeed(RSS, "feed");
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.ext_id).toBe("obsidian-1.10.2");
    expect(item.url).toBe("https://obsidian.md/changelog/2026-07-06-desktop-v1.10.2/");
    expect(item.published_at).toBe("2026-07-06T10:00:00.000Z");
    expect(item.notes).toBe("Shiny.");
  });

  test("keeps a version-like title as a string, not a number", () => {
    // "1.10" parsed as a number becomes 1.1 — a wrong version on the dashboard.
    const xml = RSS.replace("<title>1.10.2</title>", "<title>1.10</title>");
    expect(parseFeed(xml, "feed")[0]?.title).toBe("1.10");
  });

  test("sorts newest first even when the feed is oldest-first", () => {
    const reversed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>old</id><title>old</title><updated>2020-01-01T00:00:00Z</updated></entry>
      <entry><id>new</id><title>new</title><updated>2026-01-01T00:00:00Z</updated></entry>
    </feed>`;
    expect(parseFeed(reversed, "feed").map((r) => r.ext_id)).toEqual(["new", "old"]);
  });

  test("sorts undated entries last rather than dropping them", () => {
    const mixed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>undated</id><title>undated</title></entry>
      <entry><id>dated</id><title>dated</title><updated>2026-01-01T00:00:00Z</updated></entry>
    </feed>`;
    expect(parseFeed(mixed, "feed").map((r) => r.ext_id)).toEqual(["dated", "undated"]);
  });

  test("falls back to the link when an item has no guid", () => {
    const noGuid = `<rss><channel><item>
      <title>x</title><link>https://example.com/x</link>
    </item></channel></rss>`;
    expect(parseFeed(noGuid, "feed")[0]?.ext_id).toBe("https://example.com/x");
  });

  test("drops an item with neither guid nor link", () => {
    const anonymous = `<rss><channel><item><title>x</title></item></channel></rss>`;
    expect(parseFeed(anonymous, "feed")).toEqual([]);
  });

  test("handles a single entry, which the parser gives as an object not an array", () => {
    const one = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>a</id><title>a</title></entry></feed>`;
    expect(parseFeed(one, "feed")).toHaveLength(1);
  });

  test("reads a bare <channel> without an <rss> wrapper", () => {
    const bare = `<channel><item><guid>g</guid><title>t</title></item></channel>`;
    expect(parseFeed(bare, "feed")).toHaveLength(1);
  });

  test("prefers rel=alternate but accepts any href", () => {
    const selfOnly = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>a</id><title>a</title>
      <link rel="self" href="https://example.com/self"/>
    </entry></feed>`;
    expect(parseFeed(selfOnly, "feed")[0]?.url).toBe("https://example.com/self");

    const both = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>a</id><title>a</title>
      <link rel="self" href="https://example.com/self"/>
      <link rel="alternate" href="https://example.com/alt"/>
    </entry></feed>`;
    expect(parseFeed(both, "feed")[0]?.url).toBe("https://example.com/alt");
  });

  test("rejects XML that is neither RSS nor Atom", () => {
    expect(() => parseFeed("<html><body>nope</body></html>", "feed")).toThrow(SourceError);
  });

  test("rejects an empty body", () => {
    expect(() => parseFeed("", "feed")).toThrow(SourceError);
  });
});

describe("RssSource", () => {
  test("fetches and parses, returning the ETag", async () => {
    stubFetch(() => ({ body: ATOM, headers: { etag: 'W/"f"' } }));
    const result = await new RssSource().fetch("https://example.com/feed", {});
    expect(result.releases).toHaveLength(2);
    expect(result.etag).toBe('W/"f"');
  });

  test("honours a 304 and sends If-None-Match", async () => {
    const calls = stubFetch(() => ({ status: 304 }));
    const result = await new RssSource().fetch("https://example.com/feed", { etag: "abc" });
    expect(calls[0]?.headers["if-none-match"]).toBe("abc");
    expect(result.notModified).toBe(true);
  });

  test("applies the backfill limit", async () => {
    stubFetch(() => ({ body: ATOM }));
    const result = await new RssSource().fetch("https://example.com/feed", { limit: 1 });
    expect(result.releases).toHaveLength(1);
  });

  test("raises SourceError on a non-2xx", () => {
    stubFetch(() => ({ status: 500, body: "" }));
    expect(new RssSource().fetch("https://example.com/feed", {})).rejects.toThrow(SourceError);
  });
});
