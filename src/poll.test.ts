import { describe, expect, test } from "bun:test";
import { Store } from "./db.js";
import { defaultSources, poll, type SourceRegistry } from "./poll.js";
import { SourceError, type FetchOptions, type FetchResult, type Source } from "./source/index.js";

/** A source that replays scripted results and records what it was asked for. */
class FakeSource implements Source {
  readonly calls: { ref: string; opts: FetchOptions }[] = [];

  constructor(
    readonly kind: "github" | "rss",
    private readonly responder: (ref: string, opts: FetchOptions) => FetchResult,
  ) {}

  fetch(ref: string, opts: FetchOptions): Promise<FetchResult> {
    this.calls.push({ ref, opts });
    return Promise.resolve(this.responder(ref, opts));
  }
}

function ok(
  releases: { ext_id: string; tag?: string; published_at?: string }[],
  etag: string | null = null,
): FetchResult {
  return {
    releases: releases.map((r) => ({
      ext_id: r.ext_id,
      tag: r.tag ?? r.ext_id,
      title: r.tag ?? r.ext_id,
      url: `https://example.com/${r.ext_id}`,
      notes: "notes",
      published_at: r.published_at ?? "2026-07-06T10:00:00.000Z",
    })),
    etag,
    notModified: false,
  };
}

const NOT_MODIFIED: FetchResult = { releases: [], etag: null, notModified: true };

function registry(github: Source, rss?: Source): SourceRegistry {
  return {
    github,
    rss: rss ?? new FakeSource("rss", () => ok([])),
  };
}

function storeWithApp(ref = "o/r") {
  const store = new Store(":memory:");
  const app = store.upsertApp({ name: "R", kind: "github", ref });
  return { store, app };
}

describe("defaultSources", () => {
  test("registers a source for every app kind the schema allows", () => {
    // A kind with no source would fail at runtime for that app only, which is
    // exactly the sort of thing that hides until a roster edit trips it.
    const sources = defaultSources();
    expect(sources.github.kind).toBe("github");
    expect(sources.rss.kind).toBe("rss");
  });
});

describe("poll", () => {
  test("inserts new releases and reports them as the triage worklist", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }, { ext_id: "2" }], 'W/"e"'));

    const summary = await poll(store, registry(gh));

    expect(summary.inserted).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.newReleases).toHaveLength(2);
    expect(store.counts().releases).toBe(2);
    store.close();
  });

  test("stores the ETag and sends it back on the next cycle", async () => {
    const { store, app } = storeWithApp();
    const gh = new FakeSource("github", (_ref, opts) =>
      opts.etag === 'W/"e"' ? NOT_MODIFIED : ok([{ ext_id: "1" }], 'W/"e"'),
    );

    await poll(store, registry(gh));
    expect(store.getApp(app.id)!.etag).toBe('W/"e"');

    const second = await poll(store, registry(gh));
    expect(gh.calls[1]?.opts.etag).toBe('W/"e"');
    expect(second.notModified).toBe(1);
    expect(second.inserted).toBe(0);
    store.close();
  });

  test("a second poll of unchanged content inserts nothing", async () => {
    const { store } = storeWithApp();
    // No ETag from this server at all — the dedupe has to carry it alone.
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    await poll(store, registry(gh));
    const second = await poll(store, registry(gh));

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.counts().releases).toBe(1);
    store.close();
  });

  test("one app failing never stops the cycle", async () => {
    const store = new Store(":memory:");
    store.upsertApp({ name: "Bad", kind: "github", ref: "bad/repo" });
    store.upsertApp({ name: "Good", kind: "github", ref: "good/repo" });

    const gh = new FakeSource("github", (ref) => {
      if (ref === "bad/repo") throw new SourceError("GitHub 404 for bad/repo", 404);
      return ok([{ ext_id: "1" }]);
    });

    const summary = await poll(store, registry(gh));

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.app).toBe("github:bad/repo");
    expect(summary.inserted).toBe(1); // the healthy app still got polled
    store.close();
  });

  test("a failed app keeps its old ETag rather than losing it", async () => {
    const { store, app } = storeWithApp();
    store.setEtag(app.id, 'W/"kept"');
    const gh = new FakeSource("github", () => {
      throw new SourceError("GitHub 500", 500);
    });

    await poll(store, registry(gh));
    expect(store.getApp(app.id)!.etag).toBe('W/"kept"');
    store.close();
  });

  test("skips inactive apps", async () => {
    const { store, app } = storeWithApp();
    store.deactivateApp(app.id);
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    const summary = await poll(store, registry(gh));
    expect(summary.apps).toBe(0);
    expect(gh.calls).toHaveLength(0);
    store.close();
  });

  test("routes each app to the source for its kind", async () => {
    const store = new Store(":memory:");
    store.upsertApp({ name: "G", kind: "github", ref: "o/r" });
    store.upsertApp({ name: "F", kind: "rss", ref: "https://example.com/feed" });

    const gh = new FakeSource("github", () => ok([{ ext_id: "g" }]));
    const rss = new FakeSource("rss", () => ok([{ ext_id: "f" }]));

    await poll(store, registry(gh, rss));

    expect(gh.calls.map((c) => c.ref)).toEqual(["o/r"]);
    expect(rss.calls.map((c) => c.ref)).toEqual(["https://example.com/feed"]);
    store.close();
  });

  test("appId restricts the cycle to one app", async () => {
    const store = new Store(":memory:");
    const a = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    store.upsertApp({ name: "B", kind: "github", ref: "b/b" });
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    const summary = await poll(store, registry(gh), { appId: a.id });
    expect(summary.apps).toBe(1);
    expect(gh.calls.map((c) => c.ref)).toEqual(["a/a"]);
    store.close();
  });

  test("appId for an unknown or inactive app polls nothing", async () => {
    const { store, app } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    expect((await poll(store, registry(gh), { appId: 999 })).apps).toBe(0);
    store.deactivateApp(app.id);
    expect((await poll(store, registry(gh), { appId: app.id })).apps).toBe(0);
    store.close();
  });
});

describe("poll — backfill", () => {
  test("marks rows backfilled and keeps them off the triage worklist", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }, { ext_id: "2" }]));

    const summary = await poll(store, registry(gh), { backfill: true });

    expect(summary.inserted).toBe(2);
    // Backfilled rows are history, not news: never triaged, never emailed.
    expect(summary.newReleases).toEqual([]);
    expect(store.untriagedReleases()).toEqual([]);
    expect(store.digestSet()).toEqual([]);
    store.close();
  });

  test("backfilled history is still browsable in the dashboard", async () => {
    const { store, app } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));
    await poll(store, registry(gh), { backfill: true });
    expect(store.listReleases()).toHaveLength(1);
    expect(store.listAppHistory(app.id)).toHaveLength(1);
    store.close();
  });

  test("asks for BACKFILL_DEPTH and ignores the stored ETag", async () => {
    const { store, app } = storeWithApp();
    store.setEtag(app.id, 'W/"stale"');
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    await poll(store, registry(gh), { backfill: true });

    // Sending If-None-Match here would 304 past exactly the history we want.
    expect(gh.calls[0]?.opts.etag).toBeNull();
    expect(gh.calls[0]?.opts.limit).toBe(5);
    store.close();
  });

  test("a later real poll still triages a release first seen as backfill", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    await poll(store, registry(gh), { backfill: true });
    const second = await poll(store, registry(gh));

    // Deliberate: the row is already there, so it stays backfilled and unemailed.
    // This is what stops the old 108-entry backlog transferring on day one.
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.digestSet()).toEqual([]);
    store.close();
  });
});
