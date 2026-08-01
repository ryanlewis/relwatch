// SQLite store. This is the archive the dashboard reads, not just a delta ledger —
// so nothing here deletes a release, and dismissal only hides.
//
// Timestamps are ISO-8601 UTC strings throughout. SQLite has no date type, and
// lexicographic ordering of that format is chronological ordering, so ORDER BY
// works without a conversion.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AppKind = "github" | "rss";
export type Verdict = "major" | "interesting" | "maintenance";

export interface App {
  id: number;
  name: string;
  kind: AppKind;
  ref: string;
  homepage: string | null;
  etag: string | null;
  active: boolean;
  added_at: string;
  /**
   * When this app was first successfully polled. Releases published before it
   * are history, not news — see migration v2.
   */
  seeded_at: string | null;
}

export interface Release {
  id: number;
  app_id: number;
  /**
   * Upstream's own id — GitHub release id, or RSS guid/link. Deliberately not the
   * tag: repos re-point tags, so an edited release would masquerade as a new one.
   */
  ext_id: string;
  tag: string | null;
  title: string | null;
  url: string | null;
  notes: string | null;
  published_at: string | null;
  fetched_at: string;
  backfilled: boolean;
  verdict: Verdict | null;
  summary: string | null;
  breaking: boolean | null;
  highlights: string[];
  triaged_at: string | null;
  triage_error: string | null;
  emailed_at: string | null;
  dismissed_at: string | null;
}

/** A release joined to its app — what every view actually renders. */
export interface ReleaseWithApp extends Release {
  app_name: string;
  app_kind: AppKind;
  app_ref: string;
  app_homepage: string | null;
}

export interface NewApp {
  name: string;
  kind: AppKind;
  ref: string;
  homepage?: string | null;
}

export interface NewRelease {
  app_id: number;
  ext_id: string;
  tag?: string | null;
  title?: string | null;
  url?: string | null;
  notes?: string | null;
  published_at?: string | null;
  backfilled?: boolean;
}

export interface TriageResult {
  verdict: Verdict;
  summary: string;
  breaking: boolean;
  highlights: string[];
}

/**
 * The inbox definition, for callers holding rows rather than writing SQL:
 * news awaiting acknowledgement, so undismissed *and* not backfilled.
 *
 * `listReleases`, `counts().inbox` and `dismissAll` say the same thing in SQL.
 * Every other place that needs it says it through here, because dismissed
 * (something the operator did) and backfilled (something the release is) are
 * independent axes, and conflating two of them is where the bugs here start.
 */
export function inInbox(r: Pick<Release, "dismissed_at" | "backfilled">): boolean {
  return r.dismissed_at === null && !r.backfilled;
}

export interface InboxFilter {
  /** Undismissed only (the default inbox) vs everything (the "all" view). */
  includeDismissed?: boolean;
  /**
   * Include backfilled history. Off by default: the inbox is a queue of news to
   * acknowledge, and history is not news however late we happen to find it.
   */
  includeBackfilled?: boolean;
  verdict?: Verdict;
  appId?: number;
  limit?: number;
}

/** Raw column shapes, before booleans and the highlights JSON are decoded. */
interface AppRow {
  id: number;
  name: string;
  kind: AppKind;
  ref: string;
  homepage: string | null;
  etag: string | null;
  active: number;
  added_at: string;
  seeded_at: string | null;
}

interface ReleaseRow {
  id: number;
  app_id: number;
  ext_id: string;
  tag: string | null;
  title: string | null;
  url: string | null;
  notes: string | null;
  published_at: string | null;
  fetched_at: string;
  backfilled: number;
  verdict: Verdict | null;
  summary: string | null;
  breaking: number | null;
  highlights: string | null;
  triaged_at: string | null;
  triage_error: string | null;
  emailed_at: string | null;
  dismissed_at: string | null;
}

interface ReleaseWithAppRow extends ReleaseRow {
  app_name: string;
  app_kind: AppKind;
  app_ref: string;
  app_homepage: string | null;
}

// --- Migrations ------------------------------------------------------------
// Forward-only, one entry per version, applied in order inside a transaction.
// `user_version` records how far we've got. Never edit a shipped migration —
// append a new one, because a deployed DB has already run the old text.
const MIGRATIONS: readonly string[] = [
  // v1 — initial schema.
  `
  CREATE TABLE apps (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    kind      TEXT    NOT NULL CHECK (kind IN ('github','rss')),
    ref       TEXT    NOT NULL,
    homepage  TEXT,
    etag      TEXT,
    active    INTEGER NOT NULL DEFAULT 1,
    added_at  TEXT    NOT NULL,
    UNIQUE (kind, ref)
  );

  CREATE TABLE releases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    -- Upstream's identifier. Deliberately NOT the tag: repos re-point tags,
    -- which would let an edited release masquerade as a new one (or vice versa).
    ext_id        TEXT    NOT NULL,
    tag           TEXT,
    title         TEXT,
    url           TEXT,
    notes         TEXT,
    published_at  TEXT,
    fetched_at    TEXT    NOT NULL,
    backfilled    INTEGER NOT NULL DEFAULT 0,
    verdict       TEXT    CHECK (verdict IN ('major','interesting','maintenance')),
    summary       TEXT,
    breaking      INTEGER,
    highlights    TEXT,
    triaged_at    TEXT,
    triage_error  TEXT,
    emailed_at    TEXT,
    dismissed_at  TEXT,
    -- The whole basis of idempotent polling: re-seeing a release is a no-op.
    UNIQUE (app_id, ext_id)
  );

  -- The digest query, exactly. Partial so it stays tiny: rows leave the index
  -- for good once emailed or dismissed.
  CREATE INDEX releases_pending_digest
    ON releases (published_at)
    WHERE emailed_at IS NULL AND dismissed_at IS NULL AND backfilled = 0;

  -- The inbox: undismissed, newest first.
  CREATE INDEX releases_inbox
    ON releases (published_at DESC)
    WHERE dismissed_at IS NULL;

  -- Per-app history, which deliberately includes dismissed rows.
  CREATE INDEX releases_by_app ON releases (app_id, published_at DESC);

  -- The triage sweep's worklist.
  CREATE INDEX releases_untriaged
    ON releases (id)
    WHERE triaged_at IS NULL AND backfilled = 0;
  `,
  // v2 — the seed watermark.
  //
  // Without it, a first poll after backfill treats everything the backfill's
  // shallower page missed as *news* and emails it. Observed on the real
  // roster: backfill took 5 per app, the next poll's 10-per-page found 5 more
  // each, and 110 historical releases queued themselves for the first digest —
  // recreating precisely the backlog this project exists to avoid.
  //
  // Anything published before an app was seeded is history, however late we
  // happen to see it.
  `ALTER TABLE apps ADD COLUMN seeded_at TEXT;`,
  // v3 — history leaves the inbox.
  //
  // The v2 watermark stopped late-discovered history reaching the *digest*, but
  // the inbox query filtered on dismissal alone, so history still landed there
  // undismissed. Observed live: a dismiss-all cleared 300 rows, and the next
  // poll put 60 back — releases going back to 2021, correctly flagged
  // `backfilled = 1` and never emailed, but sitting in the inbox as if unread.
  // The cause is structural, not a one-off: backfill reads BACKFILL_DEPTH (5)
  // per app while a routine poll reads GITHUB_PER_PAGE (10), so the first poll
  // after a backfill discovers five more per app that the backfill never saw.
  //
  // The inbox is a queue of news to acknowledge; `digestSet` already said so
  // with `backfilled = 0`, and now `listReleases` agrees. Repoint the partial
  // index to match, or it no longer covers the query it exists for.
  `
  DROP INDEX releases_inbox;
  CREATE INDEX releases_inbox
    ON releases (published_at DESC)
    WHERE dismissed_at IS NULL AND backfilled = 0;
  `,
];

/** The version a freshly-migrated DB lands on. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function nowIso(): string {
  return new Date().toISOString();
}

function decodeApp(row: AppRow): App {
  return { ...row, active: row.active !== 0 };
}

function decodeHighlights(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Defensive: the column is ours to write, but a hand-edited DB or a future
    // schema change shouldn't crash every render.
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

function decodeRelease(row: ReleaseRow): Release {
  return {
    ...row,
    backfilled: row.backfilled !== 0,
    breaking: row.breaking === null ? null : row.breaking !== 0,
    highlights: decodeHighlights(row.highlights),
  };
}

function decodeReleaseWithApp(row: ReleaseWithAppRow): ReleaseWithApp {
  return {
    ...decodeRelease(row),
    app_name: row.app_name,
    app_kind: row.app_kind,
    app_ref: row.app_ref,
    app_homepage: row.app_homepage,
  };
}

const RELEASE_WITH_APP_SELECT = `
  SELECT r.*,
         a.name     AS app_name,
         a.kind     AS app_kind,
         a.ref      AS app_ref,
         a.homepage AS app_homepage
  FROM releases r
  JOIN apps a ON a.id = r.app_id
`;

export interface StoreOptions {
  /**
   * Open for reading only: no parent directory, no migrations, and a missing
   * file is an error rather than a new empty database.
   *
   * Both halves of that matter to the CLI, which reads a store the service
   * usually has open. A binary newer than the running service would otherwise
   * migrate the schema out from under it on what the operator thought was a
   * read; and a typo'd `RW_DB` would create an empty database and report inbox
   * zero off it, which is the most convincing possible way to say "nothing to
   * see here".
   */
  readonly?: boolean;
}

export class Store {
  readonly db: Database;
  /** Migrations on a real file are worth a journal line; per-test ones are noise. */
  private readonly quiet: boolean;

  constructor(path: string, opts: StoreOptions = {}) {
    this.quiet = path === ":memory:";
    if (opts.readonly) {
      // WAL and foreign_keys are writes to the connection's own state that a
      // reader neither needs nor is entitled to make; busy_timeout is the one
      // that matters here, so a read during a poll cycle waits it out.
      this.db = new Database(path, { readonly: true });
      this.db.exec("PRAGMA busy_timeout = 5000");
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // WAL lets the dashboard read while a poll cycle writes. foreign_keys is
    // off by default in SQLite and must be set per connection.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get() ?? { user_version: 0 };

    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        // PRAGMA won't take a bound parameter, hence the interpolation — the
        // value is a loop index, never user input.
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
      if (!this.quiet) console.log(`[db] migrated to v${v + 1}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Apps ----------------------------------------------------------------

  /**
   * Add an app, or revive/update one already on the roster.
   *
   * Re-adding a previously removed app sets `active = 1` again and keeps its
   * release history — removal is a soft delete (see `deactivateApp`).
   */
  upsertApp(app: NewApp): App {
    const row = this.db
      .query<AppRow, [string, AppKind, string, string | null, string]>(
        `INSERT INTO apps (name, kind, ref, homepage, active, added_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (kind, ref) DO UPDATE SET
           name     = excluded.name,
           homepage = COALESCE(excluded.homepage, apps.homepage),
           active   = 1
         RETURNING *`,
      )
      .get(app.name, app.kind, app.ref, app.homepage ?? null, nowIso());
    if (!row) throw new Error(`upsertApp returned no row for ${app.kind}:${app.ref}`);
    return decodeApp(row);
  }

  getApp(id: number): App | null {
    const row = this.db.query<AppRow, [number]>("SELECT * FROM apps WHERE id = ?").get(id);
    return row ? decodeApp(row) : null;
  }

  listApps(opts: { includeInactive?: boolean } = {}): App[] {
    const where = opts.includeInactive ? "" : "WHERE active = 1";
    return this.db
      .query<AppRow, []>(`SELECT * FROM apps ${where} ORDER BY name COLLATE NOCASE`)
      .all()
      .map(decodeApp);
  }

  /**
   * Roster removal. Soft, deliberately: DELETE /api/apps/:id stops the poller
   * without destroying the archive the dashboard exists to show. Re-adding the
   * same kind+ref brings it back with its history intact.
   */
  deactivateApp(id: number): boolean {
    return this.db.run("UPDATE apps SET active = 0 WHERE id = ?", [id]).changes > 0;
  }

  /** Persist the ETag from a 200 so the next poll can send If-None-Match. */
  setEtag(appId: number, etag: string | null): void {
    this.db.run("UPDATE apps SET etag = ? WHERE id = ?", [etag, appId]);
  }

  /**
   * Stamp the seed watermark on first successful poll. Idempotent: only ever
   * set once, so a later poll can't move the line and re-classify history.
   */
  markSeeded(appId: number, at = nowIso()): void {
    this.db.run("UPDATE apps SET seeded_at = ? WHERE id = ? AND seeded_at IS NULL", [at, appId]);
  }

  // --- Releases ------------------------------------------------------------

  /**
   * Insert a release if we haven't seen it. Returns the new row, or null when
   * it was already there — which is the common case on every poll after the
   * first, and must stay silent and cheap.
   */
  insertRelease(rel: NewRelease): Release | null {
    const row = this.db
      .query<
        ReleaseRow,
        [number, string, string | null, string | null, string | null, string | null, string | null, string, number]
      >(
        `INSERT INTO releases
           (app_id, ext_id, tag, title, url, notes, published_at, fetched_at, backfilled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, ext_id) DO NOTHING
         RETURNING *`,
      )
      .get(
        rel.app_id,
        rel.ext_id,
        rel.tag ?? null,
        rel.title ?? null,
        rel.url ?? null,
        rel.notes ?? null,
        rel.published_at ?? null,
        nowIso(),
        rel.backfilled ? 1 : 0,
      );
    return row ? decodeRelease(row) : null;
  }

  getRelease(id: number): ReleaseWithApp | null {
    const row = this.db
      .query<ReleaseWithAppRow, [number]>(`${RELEASE_WITH_APP_SELECT} WHERE r.id = ?`)
      .get(id);
    return row ? decodeReleaseWithApp(row) : null;
  }

  /**
   * The dashboard's list view. Newest first; news only unless asked otherwise.
   *
   * Two exclusions, for two different reasons: dismissed rows are hidden because
   * they were acknowledged, backfilled rows because they were never news. Only
   * the first is something the user did.
   */
  listReleases(filter: InboxFilter = {}): ReleaseWithApp[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (!filter.includeDismissed) clauses.push("r.dismissed_at IS NULL");
    if (!filter.includeBackfilled) clauses.push("r.backfilled = 0");
    if (filter.verdict) {
      clauses.push("r.verdict = ?");
      params.push(filter.verdict);
    }
    if (filter.appId !== undefined) {
      clauses.push("r.app_id = ?");
      params.push(filter.appId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // published_at can be null on a malformed feed; fall back to fetched_at so
    // such a row sorts sensibly instead of sinking to the bottom forever.
    const limit = filter.limit === undefined ? "" : "LIMIT ?";
    if (filter.limit !== undefined) params.push(filter.limit);
    return this.db
      .query<ReleaseWithAppRow, (string | number)[]>(
        `${RELEASE_WITH_APP_SELECT} ${where}
         ORDER BY COALESCE(r.published_at, r.fetched_at) DESC, r.id DESC ${limit}`,
      )
      .all(...params)
      .map(decodeReleaseWithApp);
  }

  /**
   * Per-app history — everything, dismissed and backfilled included, because
   * this page is where the archive is meant to be browsable.
   */
  listAppHistory(appId: number, limit = 200): ReleaseWithApp[] {
    return this.listReleases({
      appId,
      includeDismissed: true,
      includeBackfilled: true,
      limit,
    });
  }

  /**
   * The digest set: never-emailed, undismissed, and not backfilled.
   * Dismissing therefore suppresses a release from a digest
   * that hasn't gone out yet, while emailing never auto-dismisses.
   */
  digestSet(): ReleaseWithApp[] {
    return this.db
      .query<ReleaseWithAppRow, []>(
        `${RELEASE_WITH_APP_SELECT}
         WHERE r.emailed_at IS NULL AND r.dismissed_at IS NULL AND r.backfilled = 0
         ORDER BY COALESCE(r.published_at, r.fetched_at) DESC, r.id DESC`,
      )
      .all()
      .map(decodeReleaseWithApp);
  }

  /** Releases awaiting triage. Backfilled history is never triaged. */
  untriagedReleases(limit = 200): ReleaseWithApp[] {
    return this.db
      .query<ReleaseWithAppRow, [number]>(
        `${RELEASE_WITH_APP_SELECT}
         WHERE r.triaged_at IS NULL AND r.backfilled = 0
         ORDER BY r.id ASC
         LIMIT ?`,
      )
      .all(limit)
      .map(decodeReleaseWithApp);
  }

  saveTriage(id: number, t: TriageResult): void {
    this.db.run(
      `UPDATE releases
       SET verdict = ?, summary = ?, breaking = ?, highlights = ?,
           triaged_at = ?, triage_error = NULL
       WHERE id = ?`,
      [t.verdict, t.summary, t.breaking ? 1 : 0, JSON.stringify(t.highlights), nowIso(), id],
    );
  }

  /**
   * Record a triage failure. `triaged_at` stays NULL so a later sweep can retry,
   * but the release is never dropped — it renders untriaged.
   */
  saveTriageError(id: number, message: string): void {
    this.db.run("UPDATE releases SET triage_error = ? WHERE id = ?", [message.slice(0, 500), id]);
  }

  /** Marked only on a 2xx from hubbub — a send is never retried, so this is the
   * only thing standing between a failed digest and a duplicate one. */
  markEmailed(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    const stamp = nowIso();
    const update = this.db.prepare("UPDATE releases SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL");
    return this.db.transaction(() => {
      let n = 0;
      for (const id of ids) n += update.run(stamp, id).changes;
      return n;
    })();
  }

  dismiss(id: number): boolean {
    return (
      this.db.run("UPDATE releases SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL", [
        nowIso(),
        id,
      ]).changes > 0
    );
  }

  /**
   * The clear-the-decks button. Returns how many rows it actually hid.
   * Scoped to one app when `appId` is given — clearing a single noisy project
   * shouldn't mean clearing everything else with it.
   *
   * Backfilled rows are left alone: they aren't in the inbox, so the button's
   * count would over-report, and stamping `dismissed_at` on a release that was
   * never shown would make "dismissed" mean something other than acknowledged.
   */
  dismissAll(appId?: number): number {
    const stamp = nowIso();
    if (appId === undefined) {
      return this.db.run(
        "UPDATE releases SET dismissed_at = ? WHERE dismissed_at IS NULL AND backfilled = 0",
        [stamp],
      ).changes;
    }
    return this.db.run(
      `UPDATE releases SET dismissed_at = ?
       WHERE dismissed_at IS NULL AND backfilled = 0 AND app_id = ?`,
      [stamp, appId],
    ).changes;
  }

  // --- Stats ---------------------------------------------------------------

  counts(): { apps: number; releases: number; inbox: number; pendingDigest: number } {
    const one = (sql: string): number =>
      this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      apps: one("SELECT COUNT(*) AS n FROM apps WHERE active = 1"),
      releases: one("SELECT COUNT(*) AS n FROM releases"),
      // Mirrors listReleases' default, so the header tally and the list agree.
      inbox: one(
        "SELECT COUNT(*) AS n FROM releases WHERE dismissed_at IS NULL AND backfilled = 0",
      ),
      pendingDigest: one(
        `SELECT COUNT(*) AS n FROM releases
         WHERE emailed_at IS NULL AND dismissed_at IS NULL AND backfilled = 0`,
      ),
    };
  }

  /** Most recent ingest across the whole store — feeds the "quiet for 24 h" watchdog. */
  lastFetchedAt(): string | null {
    return (
      this.db.query<{ t: string | null }, []>("SELECT MAX(fetched_at) AS t FROM releases").get()?.t ??
      null
    );
  }
}

let shared: Store | null = null;

/** Process-wide store, opened lazily so tests can use their own. */
export function getStore(path: string): Store {
  if (!shared) shared = new Store(path);
  return shared;
}
