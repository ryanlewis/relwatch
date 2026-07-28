// In-process scheduling. Poll and digest are jobs inside the
// service; systemd keeps the service alive, croner keeps the jobs on time.
//
// The invariant: a job that throws must never reach the runtime unhandled. A
// crashed cron callback would take a scheduled task out silently until the next
// restart, and "the digest quietly stopped" is precisely what this project
// exists to notice.
import { Cron } from "croner";
import { DIGEST_CRON, POLL_CRON, TZ } from "./config.js";
import type { Store } from "./db.js";
import { checkQuiet, runDigest, type DigestOptions } from "./digest/index.js";
import { poll, type SourceRegistry } from "./poll.js";
import { triagePending } from "./triage/index.js";
import type { Provider } from "./triage/index.js";

export interface SchedulerDeps {
  store: Store;
  provider: Provider;
  sources?: SourceRegistry;
  /** Overrides for the digest job — the Hubbub base/key, or a dry-run flag. */
  digest?: DigestOptions;
}

/**
 * One poll cycle: fetch, then triage whatever it brought in.
 *
 * Triage runs over the store's pending set rather than the poll's return value,
 * so anything a previous cycle failed to triage gets another go without
 * needing its own schedule.
 */
export async function pollAndTriage(deps: SchedulerDeps): Promise<void> {
  const summary = await poll(deps.store, deps.sources);
  if (summary.newReleases.length === 0 && deps.store.untriagedReleases(1).length === 0) return;
  await triagePending(deps.store, deps.provider);
}

/**
 * Wrap a job so a throw is logged and swallowed. Returns whether it succeeded,
 * which is what makes the behaviour testable.
 */
export async function guard(name: string, job: () => Promise<void>): Promise<boolean> {
  const started = Date.now();
  try {
    await job();
    console.log(`[job] ${name} finished in ${Math.round((Date.now() - started) / 100) / 10}s`);
    return true;
  } catch (err) {
    console.error(`[job] ${name} failed:`, err);
    return false;
  }
}

export interface Scheduler {
  jobs: Cron[];
  stop(): void;
}

/** The defaults a bad pattern falls back to, so the service still runs. */
const FALLBACK_POLL_CRON = "0 */6 * * *";
const FALLBACK_DIGEST_CRON = "0 8 * * *";

/**
 * Validate a cron pattern, falling back loudly rather than throwing.
 *
 * A rejected pattern used to take the whole service down at startup, which
 * under `Restart=on-failure` is a crash loop: no dashboard, no polling, no
 * digest. Observed for real — systemd splits `Environment=` on whitespace, so
 * an unquoted six-field cron value arrives as just its first field, `0`.
 * Falling back keeps every other surface working while the log says exactly
 * what is wrong and how to fix it.
 */
export function safeCron(pattern: string, fallback: string, name: string): string {
  try {
    new Cron(pattern, { paused: true }).stop();
    return pattern;
  } catch (err) {
    console.error(
      `[scheduler] ${name} pattern ${JSON.stringify(pattern)} is invalid ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to "${fallback}". ` +
        `If this came from systemd, quote it: Environment="${name}=${fallback}"`,
    );
    return fallback;
  }
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  // `protect` skips a run while the previous one is still going — a poll cycle
  // that outruns its 6-hourly slot must queue behind itself, not race itself
  // into the same rows. It only works because the callbacks below are async and
  // croner awaits them; returning early would make every run look instant.
  const options = { timezone: TZ, protect: true } as const;
  const pollPattern = safeCron(POLL_CRON, FALLBACK_POLL_CRON, "RW_POLL_CRON");
  const digestPattern = safeCron(DIGEST_CRON, FALLBACK_DIGEST_CRON, "RW_DIGEST_CRON");

  const pollJob = new Cron(pollPattern, options, async () => {
    await guard("poll", () => pollAndTriage(deps));
  });

  const digestJob = new Cron(digestPattern, options, async () => {
    await guard("digest", async () => {
      await runDigest(deps.store, deps.digest);
      // Piggy-backed on the digest rather than given its own schedule: the
      // daily digest is exactly the cadence at which "nothing for 24h" matters.
      await checkQuiet(deps.store, deps.digest);
    });
  });

  const jobs = [pollJob, digestJob];
  console.log(
    `[scheduler] poll "${pollPattern}" next ${describeNext(pollJob)}; ` +
      `digest "${digestPattern}" next ${describeNext(digestJob)} (${TZ})`,
  );

  return {
    jobs,
    stop() {
      for (const job of jobs) job.stop();
    },
  };
}

function describeNext(job: Cron): string {
  return job.nextRun()?.toISOString() ?? "never";
}
