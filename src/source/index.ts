// The source seam. Two implementations (GitHub Releases, RSS/Atom) behind one
// interface, so the poller neither knows nor cares which an app uses.
import type { App, NewRelease } from "../db.js";

/** What a source hands back for one upstream release. */
export interface FetchedRelease {
  /** Upstream's stable identifier — GitHub release id, or feed guid/link. */
  ext_id: string;
  tag: string | null;
  title: string | null;
  url: string | null;
  notes: string | null;
  published_at: string | null;
}

export interface FetchResult {
  /** Newest first. Empty on a 304, which is the steady-state case. */
  releases: FetchedRelease[];
  /** Server's ETag, to send back as If-None-Match next cycle. */
  etag: string | null;
  /** True when the server said 304 — nothing changed, nothing to do. */
  notModified: boolean;
}

export interface FetchOptions {
  /** Stored ETag, sent as If-None-Match. */
  etag?: string | null;
  /** How many to ask for. Backfill wants more than a routine poll. */
  limit?: number;
  signal?: AbortSignal;
}

export interface Source {
  readonly kind: "github" | "rss";
  fetch(ref: string, opts: FetchOptions): Promise<FetchResult>;
}

/** Raised for a non-2xx, so the poller can log status without parsing a string. */
export class SourceError extends Error {
  readonly status: number | undefined;
  /**
   * Distinguishes "this app is broken" from "the whole cycle is blocked".
   * A rate limit will hit every remaining app identically, so the poller stops
   * rather than spending 37 more requests learning the same thing.
   */
  readonly rateLimited: boolean;

  constructor(message: string, status?: number, rateLimited = false) {
    super(message);
    this.name = "SourceError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

/** Shape a fetched release for the store. */
export function toNewRelease(
  app: Pick<App, "id">,
  r: FetchedRelease,
  backfilled: boolean,
): NewRelease {
  return {
    app_id: app.id,
    ext_id: r.ext_id,
    tag: r.tag,
    title: r.title,
    url: r.url,
    notes: r.notes,
    published_at: r.published_at,
    backfilled,
  };
}

/**
 * Normalise an upstream date to ISO-8601 UTC, or null.
 *
 * Feeds carry RFC-822 (`Mon, 06 Jul 2026 10:00:00 GMT`) as often as ISO, and a
 * date we can't read must not become "1970" — the store orders by this column,
 * and a bogus epoch would pin a release to the bottom of the inbox forever.
 * Null is honest and sorts by fetched_at instead.
 */
export function normaliseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Truncate release notes before they reach the LLM.
 *
 * Some projects paste an entire changelog into one release body. Triage only
 * needs the top of it, and an unbounded body is both a cost and a timeout risk.
 */
export function clampNotes(raw: string | null | undefined, max = 12_000): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[… truncated]`;
}
