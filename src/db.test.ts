import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore, SCHEMA_VERSION, Store } from "./db.js";

function freshStore(): Store {
  return new Store(":memory:");
}

function seedApp(s: Store, ref = "owner/repo") {
  return s.upsertApp({ name: "Repo", kind: "github", ref });
}

describe("migrations", () => {
  test("bring a blank DB to the current version and are idempotent", () => {
    const s = freshStore();
    const version = s.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    expect(version).toBe(SCHEMA_VERSION);
    // Re-running the migrator must be a no-op, not a second CREATE TABLE.
    expect(() => new Store(":memory:")).not.toThrow();
    s.close();
  });

  test("step a v1 database up to v2 without losing its data", () => {
    // The deployed case: a DB created before the seed watermark existed must
    // migrate forward in place, not be recreated.
    const path = join(tmpdir(), `relwatch-migrate-${process.pid}.db`);
    rmSync(path, { force: true });

    const original = new Store(path);
    const app = seedApp(original);
    original.insertRelease({ app_id: app.id, ext_id: "r1", tag: "v1" });
    // Wind it back to the v1 shape.
    original.db.exec("ALTER TABLE apps DROP COLUMN seeded_at");
    original.db.exec("PRAGMA user_version = 1");
    original.close();

    const upgraded = new Store(path);
    expect(
      upgraded.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(SCHEMA_VERSION);
    expect(upgraded.counts()).toMatchObject({ apps: 1, releases: 1 });
    // The new column exists and defaults to "never seeded", so the watermark
    // logic treats pre-existing releases as news rather than silently as history.
    expect(upgraded.listApps()[0]?.seeded_at).toBeNull();
    upgraded.close();
    rmSync(path, { force: true });
  });
});

describe("getStore", () => {
  test("returns the same instance on repeated calls", () => {
    // The service opens one connection for its whole life; a second would take
    // its own WAL lock and defeat the busy_timeout.
    expect(getStore(":memory:")).toBe(getStore(":memory:"));
  });
});

describe("apps", () => {
  test("upsert is keyed on kind+ref, and re-adding revives a removed app", () => {
    const s = freshStore();
    const a = s.upsertApp({ name: "Repo", kind: "github", ref: "owner/repo" });
    expect(s.listApps()).toHaveLength(1);

    s.deactivateApp(a.id);
    expect(s.listApps()).toHaveLength(0);
    expect(s.listApps({ includeInactive: true })).toHaveLength(1);

    const again = s.upsertApp({ name: "Repo Renamed", kind: "github", ref: "owner/repo" });
    expect(again.id).toBe(a.id); // same row, so history survives removal
    expect(again.active).toBe(true);
    expect(again.name).toBe("Repo Renamed");
    s.close();
  });

  test("the same ref under a different kind is a different app", () => {
    const s = freshStore();
    s.upsertApp({ name: "A", kind: "github", ref: "x/y" });
    s.upsertApp({ name: "B", kind: "rss", ref: "x/y" });
    expect(s.listApps()).toHaveLength(2);
    s.close();
  });

  test("removing an app cascades its releases away", () => {
    const s = freshStore();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "1" });
    s.db.run("DELETE FROM apps WHERE id = ?", [app.id]);
    expect(s.counts().releases).toBe(0);
    s.close();
  });
});

describe("insertRelease", () => {
  test("is idempotent on (app_id, ext_id)", () => {
    const s = freshStore();
    const app = seedApp(s);
    const first = s.insertRelease({ app_id: app.id, ext_id: "rel-1", tag: "v1.0.0" });
    expect(first).not.toBeNull();

    // The common case on every poll after the first: silent no-op, no throw.
    const second = s.insertRelease({ app_id: app.id, ext_id: "rel-1", tag: "v1.0.0" });
    expect(second).toBeNull();
    expect(s.counts().releases).toBe(1);
    s.close();
  });

  test("keys on ext_id, not tag — a re-pointed tag is still the same release", () => {
    const s = freshStore();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "rel-1", tag: "v1.0.0" });
    // Upstream edited the release and moved the tag: same ext_id, so no new row.
    expect(s.insertRelease({ app_id: app.id, ext_id: "rel-1", tag: "v1.0.1" })).toBeNull();
    // A genuinely new release reuses neither.
    expect(s.insertRelease({ app_id: app.id, ext_id: "rel-2", tag: "v1.0.1" })).not.toBeNull();
    expect(s.counts().releases).toBe(2);
    s.close();
  });

  test("the same ext_id under two apps is two releases", () => {
    const s = freshStore();
    const a = s.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    const b = s.upsertApp({ name: "B", kind: "github", ref: "b/b" });
    expect(s.insertRelease({ app_id: a.id, ext_id: "shared" })).not.toBeNull();
    expect(s.insertRelease({ app_id: b.id, ext_id: "shared" })).not.toBeNull();
    s.close();
  });

  test("rejects a release pointing at no app", () => {
    const s = freshStore();
    expect(() => s.insertRelease({ app_id: 999, ext_id: "x" })).toThrow();
    s.close();
  });
});

describe("triage", () => {
  test("saveTriage stores the verdict and round-trips highlights", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    s.saveTriage(rel.id, {
      verdict: "major",
      summary: "Big one.",
      breaking: true,
      highlights: ["a", "b"],
    });

    const got = s.getRelease(rel.id)!;
    expect(got.verdict).toBe("major");
    expect(got.breaking).toBe(true);
    expect(got.highlights).toEqual(["a", "b"]);
    expect(got.triaged_at).not.toBeNull();
    expect(got.triage_error).toBeNull();
    s.close();
  });

  test("an untriaged release reads back as null verdict and no highlights", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    const got = s.getRelease(rel.id)!;
    expect(got.verdict).toBeNull();
    expect(got.breaking).toBeNull();
    expect(got.highlights).toEqual([]);
    s.close();
  });

  test("a failed triage keeps the release on the worklist", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    s.saveTriageError(rel.id, "model returned prose");

    expect(s.getRelease(rel.id)!.triage_error).toBe("model returned prose");
    // triaged_at stays NULL, so a later sweep retries it rather than dropping it.
    expect(s.untriagedReleases().map((r) => r.id)).toEqual([rel.id]);
    s.close();
  });

  test("saveTriage clears a previous error", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    s.saveTriageError(rel.id, "boom");
    s.saveTriage(rel.id, { verdict: "maintenance", summary: "s", breaking: false, highlights: [] });
    expect(s.getRelease(rel.id)!.triage_error).toBeNull();
    expect(s.untriagedReleases()).toHaveLength(0);
    s.close();
  });

  test("backfilled history is never on the triage worklist", () => {
    const s = freshStore();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "old", backfilled: true });
    expect(s.untriagedReleases()).toHaveLength(0);
    s.close();
  });
});

describe("digestSet", () => {
  test("excludes emailed, dismissed and backfilled releases", () => {
    const s = freshStore();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "fresh" });
    const emailed = s.insertRelease({ app_id: app.id, ext_id: "emailed" })!;
    const dismissed = s.insertRelease({ app_id: app.id, ext_id: "dismissed" })!;
    s.insertRelease({ app_id: app.id, ext_id: "backfilled", backfilled: true });

    s.markEmailed([emailed.id]);
    s.dismiss(dismissed.id);

    expect(s.digestSet().map((r) => r.ext_id)).toEqual(["fresh"]);
    s.close();
  });

  test("dismissing suppresses a release from a digest that has not gone out", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    expect(s.digestSet()).toHaveLength(1);
    s.dismiss(rel.id);
    expect(s.digestSet()).toHaveLength(0);
    s.close();
  });

  test("emailing does not auto-dismiss — it stays in the inbox", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    s.markEmailed([rel.id]);

    expect(s.digestSet()).toHaveLength(0);
    expect(s.listReleases().map((r) => r.id)).toEqual([rel.id]);
    s.close();
  });

  test("markEmailed never re-stamps an already-emailed release", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    expect(s.markEmailed([rel.id])).toBe(1);
    const stamp = s.getRelease(rel.id)!.emailed_at;
    expect(s.markEmailed([rel.id])).toBe(0);
    expect(s.getRelease(rel.id)!.emailed_at).toBe(stamp);
    s.close();
  });

  test("markEmailed of nothing touches nothing", () => {
    const s = freshStore();
    expect(s.markEmailed([])).toBe(0);
    s.close();
  });

  test("joins the app through, so the renderer needs no second query", () => {
    const s = freshStore();
    const app = s.upsertApp({
      name: "Neovim",
      kind: "github",
      ref: "neovim/neovim",
      homepage: "https://neovim.io",
    });
    s.insertRelease({ app_id: app.id, ext_id: "r" });
    const [row] = s.digestSet();
    expect(row?.app_name).toBe("Neovim");
    expect(row?.app_ref).toBe("neovim/neovim");
    expect(row?.app_homepage).toBe("https://neovim.io");
    s.close();
  });
});

describe("listReleases", () => {
  test("hides dismissed by default and shows them on request", () => {
    const s = freshStore();
    const app = seedApp(s);
    const a = s.insertRelease({ app_id: app.id, ext_id: "a" })!;
    s.insertRelease({ app_id: app.id, ext_id: "b" });
    s.dismiss(a.id);

    expect(s.listReleases().map((r) => r.ext_id)).toEqual(["b"]);
    expect(s.listReleases({ includeDismissed: true })).toHaveLength(2);
    s.close();
  });

  test("orders newest first, falling back to fetched_at when unpublished", () => {
    const s = freshStore();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "old", published_at: "2026-01-01T00:00:00.000Z" });
    s.insertRelease({ app_id: app.id, ext_id: "new", published_at: "2026-07-01T00:00:00.000Z" });
    // No published_at at all: must still appear, ordered by when we fetched it.
    s.insertRelease({ app_id: app.id, ext_id: "undated" });

    expect(s.listReleases().map((r) => r.ext_id)).toEqual(["undated", "new", "old"]);
    s.close();
  });

  test("filters by verdict and by app", () => {
    const s = freshStore();
    const a = s.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    const b = s.upsertApp({ name: "B", kind: "github", ref: "b/b" });
    const major = s.insertRelease({ app_id: a.id, ext_id: "1" })!;
    s.insertRelease({ app_id: b.id, ext_id: "2" });
    s.saveTriage(major.id, { verdict: "major", summary: "s", breaking: false, highlights: [] });

    expect(s.listReleases({ verdict: "major" }).map((r) => r.id)).toEqual([major.id]);
    expect(s.listReleases({ appId: b.id }).map((r) => r.ext_id)).toEqual(["2"]);
    expect(s.listReleases({ limit: 1 })).toHaveLength(1);
    s.close();
  });

  test("per-app history includes dismissed releases", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "a" })!;
    s.dismiss(rel.id);
    expect(s.listAppHistory(app.id)).toHaveLength(1);
    s.close();
  });
});

describe("dismissAll", () => {
  test("hides every undismissed release and reports the count", () => {
    const s = freshStore();
    const app = seedApp(s);
    const a = s.insertRelease({ app_id: app.id, ext_id: "a" })!;
    s.insertRelease({ app_id: app.id, ext_id: "b" });
    s.dismiss(a.id);

    expect(s.dismissAll()).toBe(1); // only the still-undismissed one
    expect(s.listReleases()).toHaveLength(0);
    expect(s.dismissAll()).toBe(0);
    // Nothing was deleted — the archive is intact.
    expect(s.counts().releases).toBe(2);
    s.close();
  });
});

describe("counts and watchdog", () => {
  test("counts track the roster and the two queues", () => {
    const s = freshStore();
    const app = seedApp(s);
    const emailed = s.insertRelease({ app_id: app.id, ext_id: "e" })!;
    s.insertRelease({ app_id: app.id, ext_id: "f" });
    s.markEmailed([emailed.id]);

    expect(s.counts()).toEqual({ apps: 1, releases: 2, inbox: 2, pendingDigest: 1 });
    s.close();
  });

  test("lastFetchedAt is null until something lands", () => {
    const s = freshStore();
    expect(s.lastFetchedAt()).toBeNull();
    const app = seedApp(s);
    s.insertRelease({ app_id: app.id, ext_id: "a" });
    expect(s.lastFetchedAt()).not.toBeNull();
    s.close();
  });
});

describe("etag", () => {
  test("round-trips and clears", () => {
    const s = freshStore();
    const app = seedApp(s);
    expect(app.etag).toBeNull();
    s.setEtag(app.id, 'W/"abc"');
    expect(s.getApp(app.id)!.etag).toBe('W/"abc"');
    s.setEtag(app.id, null);
    expect(s.getApp(app.id)!.etag).toBeNull();
    s.close();
  });
});

describe("highlights decoding", () => {
  test("survives a malformed column rather than crashing a render", () => {
    const s = freshStore();
    const app = seedApp(s);
    const rel = s.insertRelease({ app_id: app.id, ext_id: "r" })!;
    s.db.run("UPDATE releases SET highlights = ? WHERE id = ?", ["not json", rel.id]);
    expect(s.getRelease(rel.id)!.highlights).toEqual([]);

    s.db.run("UPDATE releases SET highlights = ? WHERE id = ?", ['["ok", 42]', rel.id]);
    expect(s.getRelease(rel.id)!.highlights).toEqual(["ok"]);
    s.close();
  });
});
