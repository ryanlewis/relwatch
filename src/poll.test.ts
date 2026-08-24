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

/**
 * A store with one app. `seeded` marks it as already watched, which is the
 * steady state most of these tests are about — an unseeded app's first poll is
 * its seeding poll, and everything it returns is history by design.
 */
function storeWithApp(ref = "o/r", opts: { seeded?: boolean } = {}) {
  const store = new Store(":memory:");
  const app = store.upsertApp({ name: "R", kind: "github", ref });
  if (opts.seeded !== false) store.markSeeded(app.id, "2020-01-01T00:00:00.000Z");
  return { store, app: store.getApp(app.id)! };
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
    for (const ref of ["bad/repo", "good/repo"]) {
      store.markSeeded(store.upsertApp({ name: ref, kind: "github", ref }).id, "2020-01-01T00:00:00.000Z");
    }

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
    store.markSeeded(store.upsertApp({ name: "G", kind: "github", ref: "o/r" }).id, "2020-01-01T00:00:00.000Z");
    store.markSeeded(
      store.upsertApp({ name: "F", kind: "rss", ref: "https://example.com/feed" }).id,
      "2020-01-01T00:00:00.000Z",
    );

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

describe("poll — the seed watermark", () => {
  test("stamps seeded_at on the first successful poll and never moves it", async () => {
    const { store, app } = storeWithApp("o/r", { seeded: false });
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    expect(store.getApp(app.id)!.seeded_at).toBeNull();
    await poll(store, registry(gh));
    const first = store.getApp(app.id)!.seeded_at;
    expect(first).not.toBeNull();

    await poll(store, registry(gh));
    // Moving the line later would re-classify history as news.
    expect(store.getApp(app.id)!.seeded_at).toBe(first);
    store.close();
  });

  test("treats a release published before seeding as history, not news", async () => {
    const { store } = storeWithApp("o/r", { seeded: false });
    // Backfill takes the newest 5; the next poll's wider page reaches further
    // back. Those extra releases are old, and must not be emailed.
    const gh = new FakeSource("github", (_ref, opts) =>
      opts.limit === 5
        ? ok([{ ext_id: "new", published_at: "2026-07-26T10:00:00.000Z" }])
        : ok([
            { ext_id: "new", published_at: "2026-07-26T10:00:00.000Z" },
            { ext_id: "older", published_at: "2026-01-01T00:00:00.000Z" },
          ]),
    );

    await poll(store, registry(gh), { backfill: true });
    const summary = await poll(store, registry(gh));

    expect(summary.inserted).toBe(1);
    expect(summary.backfilled).toBe(1);
    expect(summary.newReleases).toEqual([]);
    // This is the whole point: the first digest stays empty of old history.
    expect(store.digestSet()).toEqual([]);
    store.close();
  });

  test("an app whose backfill failed does not email its back catalogue", async () => {
    const { store } = storeWithApp("o/r", { seeded: false });
    // Forgejo did exactly this: its backfill timed out, so it had no
    // watermark, and the next poll queued 10 releases going back to April.
    const failing = new FakeSource("github", () => {
      throw new SourceError("The operation timed out.");
    });
    await poll(store, registry(failing), { backfill: true });

    const working = new FakeSource("github", () =>
      ok([
        { ext_id: "a", published_at: "2026-07-21T08:00:00.000Z" },
        { ext_id: "b", published_at: "2026-04-29T13:00:00.000Z" },
      ]),
    );
    const summary = await poll(store, registry(working));

    expect(summary.inserted).toBe(2);
    expect(summary.backfilled).toBe(2);
    expect(store.digestSet()).toEqual([]);
    store.close();
  });

  test("an app added to the roster later starts from history, not its back catalogue", async () => {
    const store = new Store(":memory:");
    // An app can be added through the dashboard at any time. Its first poll
    // must not treat years of releases as today's news.
    const app = store.upsertApp({ name: "Late", kind: "github", ref: "late/app" });
    const gh = new FakeSource("github", () =>
      ok([
        { ext_id: "1", published_at: "2025-01-01T00:00:00.000Z" },
        { ext_id: "2", published_at: "2024-01-01T00:00:00.000Z" },
      ]),
    );

    const first = await poll(store, registry(gh));
    expect(first.newReleases).toEqual([]);
    expect(first.backfilled).toBe(2);
    expect(store.digestSet()).toEqual([]);
    expect(store.getApp(app.id)!.seeded_at).not.toBeNull();

    // Its history is browsable straight away, which is the point.
    expect(store.listAppHistory(app.id)).toHaveLength(2);
    store.close();
  });

  test("a genuinely new release after seeding is news and gets emailed", async () => {
    const { store } = storeWithApp("o/r", { seeded: false });
    const future = new Date(Date.now() + 60_000).toISOString();
    const gh = new FakeSource("github", (_ref, opts) =>
      opts.limit === 5
        ? ok([{ ext_id: "old", published_at: "2026-01-01T00:00:00.000Z" }])
        : ok([
            { ext_id: "fresh", published_at: future },
            { ext_id: "old", published_at: "2026-01-01T00:00:00.000Z" },
          ]),
    );

    await poll(store, registry(gh), { backfill: true });
    const summary = await poll(store, registry(gh));

    expect(summary.newReleases.map((r) => r.ext_id)).toEqual(["fresh"]);
    expect(store.digestSet().map((r) => r.ext_id)).toEqual(["fresh"]);
    store.close();
  });

  test("an undated release after seeding is treated as news, not silently buried", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));
    await poll(store, registry(gh));

    const undated = new FakeSource("github", () => ({
      releases: [
        { ext_id: "2", tag: "v2", title: "v2", url: null, notes: null, published_at: null },
      ],
      etag: null,
      notModified: false,
    }));
    const summary = await poll(store, registry(undated));
    expect(summary.newReleases).toHaveLength(1);
    store.close();
  });
});

describe("poll — rate limiting", () => {
  test("abandons the cycle instead of burning a request per remaining app", async () => {
    const store = new Store(":memory:");
    for (const ref of ["a/a", "b/b", "c/c"]) {
      store.upsertApp({ name: ref, kind: "github", ref });
    }
    const gh = new FakeSource("github", () => {
      throw new SourceError("GitHub rate limit exhausted", 403, true);
    });

    const summary = await poll(store, registry(gh));

    expect(summary.rateLimited).toBe(true);
    // One failure, not three: every remaining app would get the same 403.
    expect(summary.failed).toHaveLength(1);
    expect(gh.calls).toHaveLength(1);
    store.close();
  });

  test("an ordinary per-app failure still only skips that app", async () => {
    const store = new Store(":memory:");
    for (const ref of ["a/a", "b/b"]) store.upsertApp({ name: ref, kind: "github", ref });
    const gh = new FakeSource("github", (ref) => {
      if (ref === "a/a") throw new SourceError("GitHub 404", 404);
      return ok([{ ext_id: "1" }]);
    });

    const summary = await poll(store, registry(gh));
    expect(summary.rateLimited).toBe(false);
    expect(summary.failed).toHaveLength(1);
    expect(summary.inserted).toBe(1);
    store.close();
  });
});

describe("poll — the liveness stamp", () => {
  test("a cycle that ingested stamps the watermark", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    expect(store.lastPolledAt()).toBeNull();
    await poll(store, registry(gh));
    expect(store.lastPolledAt()).not.toBeNull();
    store.close();
  });

  test("a cycle of pure 304s still stamps — quiet is not dead", async () => {
    // The case the stamp exists for: every poll runs to time, nothing has
    // shipped, and lastFetchedAt() alone would call the poller stale.
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => NOT_MODIFIED);

    await poll(store, registry(gh));
    expect(store.lastPolledAt()).not.toBeNull();
    expect(store.lastFetchedAt()).toBeNull();
    store.close();
  });

  test("a cycle where every app failed leaves the stamp alone", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => {
      throw new SourceError("GitHub 500", 500);
    });

    await poll(store, registry(gh));
    expect(store.lastPolledAt()).toBeNull();
    store.close();
  });

  test("rate limited before anything answered leaves the stamp alone", async () => {
    const { store } = storeWithApp();
    const gh = new FakeSource("github", () => {
      throw new SourceError("GitHub rate limit exhausted", 403, true);
    });

    await poll(store, registry(gh));
    expect(store.lastPolledAt()).toBeNull();
    store.close();
  });

  test("one healthy app among failures is enough to stamp", async () => {
    const store = new Store(":memory:");
    for (const ref of ["bad/repo", "good/repo"]) {
      store.markSeeded(store.upsertApp({ name: ref, kind: "github", ref }).id, "2020-01-01T00:00:00.000Z");
    }
    const gh = new FakeSource("github", (ref) => {
      if (ref === "bad/repo") throw new SourceError("GitHub 404", 404);
      return NOT_MODIFIED;
    });

    await poll(store, registry(gh));
    expect(store.lastPolledAt()).not.toBeNull();
    store.close();
  });
});

describe("poll — backfill", () => {
  test("marks rows backfilled and keeps them off the triage worklist", async () => {
    const { store } = storeWithApp("o/r", { seeded: false });
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }, { ext_id: "2" }]));

    const summary = await poll(store, registry(gh), { backfill: true });

    expect(summary.inserted).toBe(2);
    // Backfilled rows are history, not news: never triaged, never emailed.
    expect(summary.newReleases).toEqual([]);
    expect(store.untriagedReleases()).toEqual([]);
    expect(store.digestSet()).toEqual([]);
    store.close();
  });

  test("backfilled history is browsable but stays out of the inbox", async () => {
    const { store, app } = storeWithApp("o/r", { seeded: false });
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));
    await poll(store, registry(gh), { backfill: true });

    // The inbox is a queue of news to acknowledge — history was never news,
    // so it must not arrive there asking to be dismissed.
    expect(store.listReleases()).toHaveLength(0);
    expect(store.listReleases({ includeBackfilled: true })).toHaveLength(1);
    expect(store.listAppHistory(app.id)).toHaveLength(1);
    store.close();
  });

  test("asks for BACKFILL_DEPTH and ignores the stored ETag", async () => {
    const { store, app } = storeWithApp("o/r", { seeded: false });
    store.setEtag(app.id, 'W/"stale"');
    const gh = new FakeSource("github", () => ok([{ ext_id: "1" }]));

    await poll(store, registry(gh), { backfill: true });

    // Sending If-None-Match here would 304 past exactly the history we want.
    expect(gh.calls[0]?.opts.etag).toBeNull();
    expect(gh.calls[0]?.opts.limit).toBe(5);
    store.close();
  });

  test("a later real poll still triages a release first seen as backfill", async () => {
    const { store } = storeWithApp("o/r", { seeded: false });
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
