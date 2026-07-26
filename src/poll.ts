// The poll cycle (DESIGN §4.2). Walks the active roster, fetches each app
// through its source, inserts what's new.
//
// The governing rule: a failure for one app is logged and skipped, never fatal
// to the cycle. 37 healthy feeds must not go unpolled because one repo 404s.
import { BACKFILL_DEPTH, GITHUB_PER_PAGE } from "./config.js";
import type { App, Release, Store } from "./db.js";
import { GitHubSource } from "./source/github.js";
import { RssSource } from "./source/rss.js";
import { toNewRelease, type Source } from "./source/index.js";

export interface PollSummary {
  apps: number;
  /** Apps whose source said 304 — the cheap, common outcome. */
  notModified: number;
  inserted: number;
  /** Rows already present; expected to dominate on a 200 with no new release. */
  skipped: number;
  failed: { app: string; error: string }[];
  /** Newly inserted, non-backfilled releases — the triage worklist. */
  newReleases: Release[];
}

export interface PollOptions {
  /**
   * Backfill mode: take the last BACKFILL_DEPTH per app, mark them
   * `backfilled = 1`, and never triage or email them. This is how the dashboard
   * opens with history without the old 108-entry backlog transferring
   * (DESIGN §6.1).
   */
  backfill?: boolean;
  /** Restrict to one app — used when the roster gains an app mid-cycle. */
  appId?: number;
  signal?: AbortSignal;
}

export type SourceRegistry = Record<App["kind"], Source>;

export function defaultSources(): SourceRegistry {
  return { github: new GitHubSource(), rss: new RssSource() };
}

export async function poll(
  store: Store,
  sources: SourceRegistry = defaultSources(),
  opts: PollOptions = {},
): Promise<PollSummary> {
  const apps = opts.appId === undefined
    ? store.listApps()
    : [store.getApp(opts.appId)].filter((a): a is App => a !== null && a.active);

  const summary: PollSummary = {
    apps: apps.length,
    notModified: 0,
    inserted: 0,
    skipped: 0,
    failed: [],
    newReleases: [],
  };

  const limit = opts.backfill ? BACKFILL_DEPTH : GITHUB_PER_PAGE;
  if (opts.backfill && BACKFILL_DEPTH === 0) return summary;

  for (const app of apps) {
    try {
      const source = sources[app.kind];
      if (!source) throw new Error(`no source for kind ${app.kind}`);

      // Sequential on purpose. 38 apps at a few hundred ms each is ~10 s once
      // every 6 hours, and firing them in parallel would burst against
      // GitHub's 60/hr anonymous limit for no useful gain.
      // oxlint-disable-next-line no-await-in-loop
      const result = await source.fetch(app.ref, {
        // A backfill must not be short-circuited by a 304 from the last poll —
        // that's precisely the case where we want the full list back.
        etag: opts.backfill ? null : app.etag,
        limit,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (result.notModified) {
        summary.notModified++;
        continue;
      }

      for (const fetched of result.releases) {
        const row = store.insertRelease(toNewRelease(app, fetched, opts.backfill === true));
        if (row) {
          summary.inserted++;
          if (!row.backfilled) summary.newReleases.push(row);
        } else {
          summary.skipped++;
        }
      }

      // Only store the ETag once the rows are safely in. Storing it first means
      // a crash mid-insert leaves us with an ETag claiming we have releases we
      // never wrote, and the next poll 304s straight past them.
      store.setEtag(app.id, result.etag);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed.push({ app: `${app.kind}:${app.ref}`, error: message });
      console.error(`[poll] ${app.kind}:${app.ref} failed: ${message}`);
    }
  }

  console.log(
    `[poll] ${summary.apps} apps: ${summary.inserted} new, ${summary.skipped} seen, ` +
      `${summary.notModified} unchanged, ${summary.failed.length} failed` +
      (opts.backfill ? " (backfill)" : ""),
  );
  return summary;
}
