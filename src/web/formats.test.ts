// The machine renderings: ?format=json and ?format=md over the three read
// views. Everything here goes through `handle`, because the point of the
// feature is that all three formats see one view object — testing the
// renderers in isolation would not prove that.
import { describe, expect, test } from "bun:test";
import { Store } from "../db.js";
import { url } from "./auth.js";
import { inline, lineStart, negotiate } from "./formats.js";
import { handle } from "./routes.js";

const ADMIN = "admin@example.com";

/** A fixed "now", so relative times and day labels don't drift with the clock. */
const NOW = Date.parse("2026-08-01T09:00:00.000Z");

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url(path)}`, { headers });
}

interface Fixture {
  store: Store;
  nvimId: number;
  bunId: number;
  majorId: number;
  untriagedId: number;
}

/**
 * Two apps and four releases spanning every axis the renderings have to keep
 * apart: triaged/untriaged, dismissed/not, backfilled/not.
 */
function seeded(): Fixture {
  const store = new Store(":memory:");
  const nvim = store.upsertApp({
    name: "Neovim",
    kind: "github",
    ref: "neovim/neovim",
    homepage: "https://neovim.io",
  });
  const bun = store.upsertApp({ name: "Bun", kind: "github", ref: "oven-sh/bun" });

  const major = store.insertRelease({
    app_id: nvim.id,
    ext_id: "r1",
    tag: "v0.12.0",
    title: "v0.12.0",
    url: "https://github.com/neovim/neovim/releases/tag/v0.12.0",
    published_at: "2026-07-30T10:00:00.000Z",
  })!;
  store.saveTriage(major.id, {
    verdict: "major",
    summary: "Rewrites the LSP client.",
    breaking: true,
    highlights: ["vim.lsp.config() replaces lspconfig", ":checkhealth reports the path"],
  });

  const maint = store.insertRelease({
    app_id: bun.id,
    ext_id: "r2",
    tag: "v1.3.9",
    url: "https://github.com/oven-sh/bun/releases/tag/v1.3.9",
    published_at: "2026-07-29T09:00:00.000Z",
  })!;
  store.saveTriage(maint.id, {
    verdict: "maintenance",
    summary: "Bug fixes.",
    breaking: false,
    highlights: [],
  });
  store.dismiss(maint.id);

  const untriaged = store.insertRelease({
    app_id: bun.id,
    ext_id: "r3",
    tag: "v1.3.10",
    published_at: "2026-07-29T08:00:00.000Z",
  })!;
  store.saveTriageError(untriaged.id, "gateway timeout");

  const old = store.insertRelease({
    app_id: nvim.id,
    ext_id: "r0",
    tag: "v0.9.0",
    published_at: "2021-01-01T00:00:00.000Z",
    backfilled: true,
  })!;
  expect(old.backfilled).toBe(true);

  return { store, nvimId: nvim.id, bunId: bun.id, majorId: major.id, untriagedId: untriaged.id };
}

async function json(store: Store, path: string): Promise<Record<string, unknown>> {
  const res = await handle(req(path), { store, now: NOW });
  expect(res.headers.get("content-type")).toContain("application/json");
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("expected a JSON object");
  return { ...body };
}

async function md(store: Store, path: string): Promise<string> {
  const res = await handle(req(path), { store, now: NOW });
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  return res.text();
}

/** The releases array, as records, without asserting a shape that isn't checked. */
function releasesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return arrayOf(body, "releases");
}

function arrayOf(body: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items: unknown = body[key];
  if (!Array.isArray(items)) throw new Error(`expected ${key} to be an array`);
  return items.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error(`expected ${key} of objects`);
    return { ...item };
  });
}

// --- negotiation -----------------------------------------------------------

const params = (q: string): URLSearchParams => new URLSearchParams(q);
const accepting = (accept: string): Request => new Request("http://x/", { headers: { accept } });

describe("negotiate", () => {
  const plain = new Request("http://x/");

  test("?format= wins, so a plain link reaches the machine renderings", () => {
    expect(negotiate(params("format=json"), plain)).toBe("json");
    expect(negotiate(params("format=md"), plain)).toBe("md");
    expect(negotiate(params("format=markdown"), plain)).toBe("md");
    expect(negotiate(params("format=MD"), plain)).toBe("md");
    expect(negotiate(params("format=html"), plain)).toBe("html");
  });

  test("falls back to Accept when no format is asked for", () => {
    expect(negotiate(params(""), accepting("application/json"))).toBe("json");
    expect(negotiate(params(""), accepting("text/markdown"))).toBe("md");
  });

  test("a browser's Accept still gets HTML", () => {
    const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(negotiate(params(""), accepting(browser))).toBe("html");
    expect(negotiate(params(""), plain)).toBe("html");
  });

  test("an explicit format beats a conflicting Accept", () => {
    expect(negotiate(params("format=md"), accepting("application/json"))).toBe("md");
  });

  test("a bogus format falls back to HTML rather than erroring", () => {
    expect(negotiate(params("format=yaml"), plain)).toBe("html");
    expect(negotiate(params("format="), plain)).toBe("html");
  });
});

// --- markdown escaping -----------------------------------------------------

describe("inline", () => {
  test("flattens newlines, so upstream text cannot open a block", () => {
    expect(inline("v1.0\n## Injected\n- fake")).toBe("v1.0 ## Injected - fake");
    expect(inline("a\r\n\tb")).toBe("a b");
  });

  test("escapes the characters that change inline rendering", () => {
    expect(inline("*bold* _em_ `code` [link] a|b \\x")).toBe(
      "\\*bold\\* \\_em\\_ \\`code\\` \\[link\\] a\\|b \\\\x",
    );
  });

  test("renders null and undefined as nothing", () => {
    expect(inline(null)).toBe("");
    expect(inline(undefined)).toBe("");
    expect(inline(42)).toBe("42");
  });

  test("leaves a version tag alone — it is not at the start of its line", () => {
    // `\0` is not a markdown escape, so escaping here would render the tag
    // literally as "\0.12.1". Nearly every tag starts with a digit.
    expect(inline("0.12.1")).toBe("0.12.1");
    expect(inline("v1.3.9")).toBe("v1.3.9");
    expect(inline("- not a bullet here")).toBe("- not a bullet here");
  });
});

describe("lineStart", () => {
  test("escapes a block opener, because this value does begin a line", () => {
    expect(lineStart("# heading")).toBe("\\# heading");
    expect(lineStart("- bullet")).toBe("\\- bullet");
    expect(lineStart("> quote")).toBe("\\> quote");
    expect(lineStart("1. item")).toBe("\\1. item");
  });

  test("leaves a block opener alone mid-value, where it opens nothing", () => {
    expect(lineStart("v1 # not a heading")).toBe("v1 # not a heading");
  });

  test("still flattens and escapes the way inline does", () => {
    expect(lineStart("a\nb *c*")).toBe("a b \\*c\\*");
  });
});

// --- inbox -----------------------------------------------------------------

describe("GET /?format=json", () => {
  test("returns the inbox with the filter and the cap it was read under", async () => {
    const { store, majorId } = seeded();
    const body = await json(store, "/?format=json");

    expect(body["view"]).toBe("inbox");
    expect(body["counts"]).toMatchObject({ apps: 2, inbox: 2, releases: 4 });
    expect(body["filter"]).toEqual({ verdict: null, app: null, all: false });
    expect(body["limit"]).toBe(300);
    expect(body["limit_reached"]).toBe(false);

    const releases = releasesOf(body);
    // The dismissed one and the backfilled one are both out, for different
    // reasons — the same two exclusions the HTML inbox makes.
    expect(releases.map((r) => r["id"])).toEqual([majorId, expect.any(Number)]);
    expect(releases[0]).toMatchObject({
      id: majorId,
      tag: "v0.12.0",
      verdict: "major",
      breaking: true,
      summary: "Rewrites the LSP client.",
      highlights: ["vim.lsp.config() replaces lspconfig", ":checkhealth reports the path"],
      in_inbox: true,
      backfilled: false,
      dismissed_at: null,
      emailed_at: null,
    });
    expect(releases[0]?.["app"]).toEqual({
      id: expect.any(Number),
      name: "Neovim",
      kind: "github",
      ref: "neovim/neovim",
    });
  });

  test("omits the raw notes body, which is the input to triage, not its output", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    store.insertRelease({
      app_id: app.id,
      ext_id: "r1",
      tag: "v1",
      notes: "x".repeat(50_000),
      published_at: "2026-07-30T10:00:00.000Z",
    });

    const releases = releasesOf(await json(store, "/?format=json"));
    expect(releases[0]).not.toHaveProperty("notes");
    expect(JSON.stringify(releases)).not.toContain("xxxx");
  });

  test("reports a triage failure rather than hiding the release", async () => {
    const { store, untriagedId } = seeded();
    const releases = releasesOf(await json(store, "/?format=json"));
    const failed = releases.find((r) => r["id"] === untriagedId);
    expect(failed).toMatchObject({
      verdict: null,
      summary: null,
      triaged_at: null,
      triage_error: "gateway timeout",
    });
  });

  test("?all=1 includes dismissed and backfilled, and says so in the filter", async () => {
    const { store } = seeded();
    const body = await json(store, "/?all=1&format=json");
    expect(body["filter"]).toMatchObject({ all: true });
    expect(releasesOf(body)).toHaveLength(4);
    expect(releasesOf(body).some((r) => r["backfilled"] === true)).toBe(true);
    expect(releasesOf(body).some((r) => r["dismissed_at"] !== null)).toBe(true);
  });

  test("reports the verdict and app filters it applied", async () => {
    const { store, nvimId } = seeded();
    const byVerdict = await json(store, "/?verdict=major&format=json");
    expect(byVerdict["filter"]).toMatchObject({ verdict: "major" });
    expect(releasesOf(byVerdict)).toHaveLength(1);

    const byApp = await json(store, `/?app=${nvimId}&format=json`);
    expect(byApp["filter"]).toMatchObject({ app: nvimId });
    expect(releasesOf(byApp)).toHaveLength(1);
  });

  test("drops a javascript: url rather than passing it on", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    store.insertRelease({
      app_id: app.id,
      ext_id: "r1",
      tag: "v1",
      url: "javascript:alert(1)",
      published_at: "2026-07-30T10:00:00.000Z",
    });
    expect(releasesOf(await json(store, "/?format=json"))[0]?.["url"]).toBeNull();
  });

  test("says when it hit the row cap, because 300 rows looks like an answer", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    for (let i = 0; i < 301; i++) {
      store.insertRelease({
        app_id: app.id,
        ext_id: `r${i}`,
        tag: `v${i}`,
        published_at: "2026-07-30T10:00:00.000Z",
      });
    }

    const body = await json(store, "/?format=json");
    expect(releasesOf(body)).toHaveLength(300);
    expect(body["limit_reached"]).toBe(true);
    expect(await md(store, "/?format=md")).toContain("the list limit was reached");
  });
});

describe("GET /?format=md", () => {
  test("renders day sections, badges, highlights and a dismissable id", async () => {
    const { store, majorId } = seeded();
    const text = await md(store, "/?format=md");

    expect(text).toContain("# relwatch — inbox");
    expect(text).toContain("2 unread · 2 apps · 4 releases");
    expect(text).toContain("## 2026-07-30");
    expect(text).toContain("### Neovim — v0.12.0 `major` `breaking`");
    expect(text).toContain("Rewrites the LSP client.");
    expect(text).toContain("- vim.lsp.config() replaces lspconfig");
    expect(text).toContain(
      `id ${majorId} · 2d ago · https://github.com/neovim/neovim/releases/tag/v0.12.0`,
    );
    // The id is only useful with somewhere to send it.
    expect(text).toContain(`POST ${url("/api/releases/<id>/dismiss")}`);
  });

  test("labels an untriaged release rather than dropping it", async () => {
    const { store } = seeded();
    const text = await md(store, "/?format=md");
    expect(text).toContain("### Bun — v1.3.10 `not triaged`");
    expect(text).toContain("_Not triaged._");
  });

  test("marks history and dismissed under ?all=1", async () => {
    const { store } = seeded();
    const text = await md(store, "/?all=1&format=md");
    expect(text).toContain("Filter: all=1");
    expect(text).toContain("`history`");
    expect(text).toContain("`dismissed`");
  });

  test("says inbox zero rather than rendering an empty document", async () => {
    const store = new Store(":memory:");
    expect(await md(store, "/?format=md")).toContain("Inbox zero — no news waiting.");
    expect(await md(store, "/?all=1&format=md")).toContain("No releases match this filter.");
  });

  test("leaves a real version tag intact in its heading", async () => {
    // Regression: escaping block openers everywhere turned "0.12.1" into
    // "\0.12.1", which markdown renders literally — a corrupted version number
    // on the majority of releases, since most tags start with a digit.
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "uv", kind: "github", ref: "astral-sh/uv" });
    store.insertRelease({
      app_id: app.id,
      ext_id: "r1",
      tag: "0.12.1",
      published_at: "2026-07-30T10:00:00.000Z",
    });

    const text = await md(store, "/?format=md");
    expect(text).toContain("### uv — 0.12.1");
    expect(text).not.toContain("\\0");
  });

  test("flattens an upstream title so it cannot forge a section", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    store.insertRelease({
      app_id: app.id,
      ext_id: "r1",
      tag: "v1\n## Forged\n\n- forged bullet",
      published_at: "2026-07-30T10:00:00.000Z",
    });

    const text = await md(store, "/?format=md");
    expect(text).toContain("### A — v1 ## Forged - forged bullet");
    // Exactly one heading of each level: the title, and the one day section.
    expect(text.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(0);
  });
});

// --- app page --------------------------------------------------------------

describe("GET /app/:id in json and md", () => {
  test("json carries the app, its three tallies and its full history", async () => {
    const { store, nvimId } = seeded();
    const body = await json(store, `/app/${nvimId}?format=json`);

    expect(body["view"]).toBe("app");
    expect(body["app"]).toMatchObject({
      id: nvimId,
      name: "Neovim",
      kind: "github",
      ref: "neovim/neovim",
      homepage: "https://neovim.io",
      active: true,
    });
    // Overlapping by design: history is neither in the inbox nor dismissed.
    expect(body["tallies"]).toEqual({ total: 2, inbox: 1, dismissed: 0, history: 1 });
    expect(body["hide_dismissed"]).toBe(false);
    expect(releasesOf(body)).toHaveLength(2);
  });

  test("?hide=1 narrows the list but leaves the tallies counting everything", async () => {
    const { store, nvimId } = seeded();
    const body = await json(store, `/app/${nvimId}?hide=1&format=json`);
    expect(body["hide_dismissed"]).toBe(true);
    expect(body["tallies"]).toMatchObject({ total: 2, history: 1 });
    expect(releasesOf(body)).toHaveLength(1);
  });

  test("md leads with the app, not the release's own app name", async () => {
    const { store, nvimId } = seeded();
    const text = await md(store, `/app/${nvimId}?format=md`);

    expect(text).toContain("# Neovim");
    expect(text).toContain("github · neovim/neovim · https://neovim.io");
    expect(text).toContain("2 releases · 1 in inbox · 0 dismissed · 1 history");
    // The app is the page, so cards drop the redundant prefix.
    expect(text).toContain("### v0.12.0 `major` `breaking`");
    expect(text).not.toContain("### Neovim — v0.12.0");
    // The legend only earns its space when there is history to explain.
    expect(text).toContain("published before this app was seeded");
  });

  test("md says so when an app has nothing recorded", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "Empty", kind: "rss", ref: "https://e.example/f" });
    expect(await md(store, `/app/${app.id}?format=md`)).toContain(
      "Nothing recorded for this app yet.",
    );
  });

  test("md says so when ?hide=1 empties a non-empty app", async () => {
    const { store, bunId } = seeded();
    const store2 = store;
    store2.dismissAll(bunId);
    expect(await md(store2, `/app/${bunId}?hide=1&format=md`)).toContain(
      "Nothing left in the inbox for this app.",
    );
  });

  test("a removed app is marked, not hidden", async () => {
    const { store, nvimId } = seeded();
    store.deactivateApp(nvimId);
    expect(await md(store, `/app/${nvimId}?format=md`)).toContain("# Neovim (removed)");
    const body = await json(store, `/app/${nvimId}?format=json`);
    expect(body["app"]).toMatchObject({ active: false });
  });

  test("404s an unknown app whatever format was asked for", async () => {
    const { store } = seeded();
    for (const path of ["/app/999?format=json", "/app/999?format=md"]) {
      expect((await handle(req(path), { store })).status).toBe(404);
    }
  });
});

// --- roster ----------------------------------------------------------------

describe("GET /roster in json and md", () => {
  test("json lists every app, removed ones included", async () => {
    const { store, bunId } = seeded();
    store.deactivateApp(bunId);

    const body = await json(store, "/roster?format=json");
    expect(body["view"]).toBe("roster");
    const apps = arrayOf(body, "apps");
    expect(apps).toHaveLength(2);
    expect(apps).toContainEqual(expect.objectContaining({ name: "Bun", active: false }));
    // counts.apps is the *active* roster, which is why both numbers are here.
    expect(body["counts"]).toMatchObject({ apps: 1 });
  });

  test("md renders a table with the ids the app route needs", async () => {
    const { store, nvimId } = seeded();
    const text = await md(store, "/roster?format=md");
    expect(text).toContain("| Id | Name | Kind | Reference | State |");
    expect(text).toContain(`| ${nvimId} | Neovim | github | neovim/neovim | active |`);
  });

  test("a pipe in an app name cannot break the table apart", async () => {
    const store = new Store(":memory:");
    store.upsertApp({ name: "a | b", kind: "github", ref: "a/b" });
    const text = await md(store, "/roster?format=md");
    const row = text.split("\n").find((l) => l.includes("a \\| b"));
    expect(row).toBeDefined();
    // Split on cell separators only — an escaped pipe is content, which is the
    // whole point, so the row still has exactly its five columns.
    expect(row?.split(/(?<!\\)\|/).filter((c) => c.trim() !== "")).toHaveLength(5);
  });

  test("md says so on an empty roster", async () => {
    const store = new Store(":memory:");
    expect(await md(store, "/roster?format=md")).toContain("Nothing on the roster yet.");
  });
});

// --- the formats agree -----------------------------------------------------

describe("the three renderings", () => {
  test("show the same release set for the same query", async () => {
    const { store } = seeded();
    for (const query of ["", "?all=1", "?verdict=major"]) {
      const ids = releasesOf(await json(store, `/${query}${query ? "&" : "?"}format=json`)).map(
        (r) => r["id"],
      );
      const text = await md(store, `/${query}${query ? "&" : "?"}format=md`);
      const html = await (await handle(req(`/${query}`), { store, now: NOW })).text();

      for (const id of ids) {
        expect(text).toContain(`id ${String(id)} ·`);
        expect(html).toContain(`id="release-${String(id)}"`);
      }
      expect(text.split("### ")).toHaveLength(ids.length + 1);
    }
  });

  test("html is still the default, and admin state never leaks into the data", async () => {
    const { store } = seeded();
    const res = await handle(req("/", { "x-exedev-email": ADMIN }), { store, now: NOW });
    expect(res.headers.get("content-type")).toContain("text/html");

    const asAdmin = await handle(req("/?format=json", { "x-exedev-email": ADMIN }), { store });
    const anon = await handle(req("/?format=json"), { store });
    expect(await asAdmin.text()).toBe(await anon.text());
  });
});
