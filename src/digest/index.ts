// The digest job. Query, render, send, mark.
import type { Store } from "../db.js";
import { renderDigest } from "./render.js";
import { alert, sendDigest, type SendResult } from "./send.js";

export interface DigestRunResult {
  /** Releases the digest covered. 0 means nothing was sent, by design. */
  sent: number;
  skipped: boolean;
  result?: SendResult;
}

export interface DigestOptions {
  key?: string;
  base?: string;
  dryRun?: boolean;
  now?: Date;
  maxHtmlBytes?: number;
}

export async function runDigest(store: Store, opts: DigestOptions = {}): Promise<DigestRunResult> {
  const releases = store.digestSet();

  // Today's behaviour, kept: an empty digest sends nothing at all rather than
  // an email saying there is nothing.
  if (releases.length === 0) {
    console.log("[digest] nothing to send");
    return { sent: 0, skipped: true };
  }

  const digest = renderDigest(releases, {
    ...(opts.maxHtmlBytes === undefined ? {} : { maxHtmlBytes: opts.maxHtmlBytes }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });

  if (digest.truncated > 0) {
    console.warn(`[digest] size cap dropped ${digest.truncated} releases from this send`);
  }

  const result = await sendDigest(digest, opts);

  if (!result.ok) {
    console.error(`[digest] send failed (${result.status}): ${result.error ?? "unknown"}`);
    // emailed_at stays unset, so tomorrow's digest covers these releases. This
    // is deliberate and is why we never retry: delivery is at-least-once with
    // no idempotency key, so a retry risks a duplicate digest.
    //
    // No catch here: alert() reports failure by returning, never by throwing,
    // so a dead ntfy channel can't take the digest job down with it.
    const alerted = await alert(
      "relwatch: digest failed",
      `${result.error ?? "unknown error"} — ${releases.length} releases roll into tomorrow.`,
      opts,
    );
    if (!alerted.ok) console.error(`[digest] alert failed too: ${alerted.error ?? "unknown"}`);
    return { sent: 0, skipped: false, result };
  }

  // Mark only what the digest actually contained: anything the size cap
  // dropped stays unemailed and lands in the next one.
  const marked = store.markEmailed(digest.ids);
  console.log(`[digest] sent ${marked} releases (status ${result.status})`);
  return { sent: marked, skipped: false, result };
}

/**
 * Watchdog: nothing ingested for 24 h means the poller is silently broken,
 * which looks exactly like a quiet week from the outside.
 */
export async function checkQuiet(
  store: Store,
  opts: DigestOptions & { thresholdMs?: number } = {},
): Promise<boolean> {
  const threshold = opts.thresholdMs ?? 24 * 60 * 60 * 1000;
  const last = store.lastFetchedAt();
  const now = (opts.now ?? new Date()).getTime();

  // No releases at all is a fresh install, not a fault.
  if (last === null) return false;

  const age = now - Date.parse(last);
  if (Number.isNaN(age) || age < threshold) return false;

  const hours = Math.floor(age / 3_600_000);
  console.warn(`[watchdog] nothing fetched for ${hours}h`);
  const alerted = await alert(
    "relwatch: no releases fetched",
    `Nothing has been ingested for ${hours}h. The poller may be failing silently.`,
    opts,
  );
  if (!alerted.ok) console.error(`[watchdog] alert failed: ${alerted.error ?? "unknown"}`);
  return true;
}
