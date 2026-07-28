// The provider seam and the triage sweep that drives it.
//
// One LLM call per release, at ingest, verdict stored forever. Batching was tried
// first and abandoned: asked to triage 108 releases in one call, both of the
// frontier models measured dropped ~2% of the ids outright, which needs
// chunk/merge/assert machinery to detect and repair. With no batch there are no
// ids to drop, so the failure mode is structurally impossible instead.
import pLimit from "p-limit";
import { LLM_CONCURRENCY, LLM_TIMEOUT_MS, RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from "../config.js";
import type { ReleaseWithApp, Store } from "../db.js";
import type { ReleaseInput, Triage } from "./schema.js";

export interface Provider {
  readonly name: string;
  triage(release: ReleaseInput, signal: AbortSignal): Promise<Triage>;
}

/** Carries the HTTP status so the retry policy can tell 429 from 400. */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    // Retry 5xx and 429 only. A 4xx is our bug — retrying burns quota and
    // delays the honest failure. No status at all means a transport error,
    // which is worth one more go.
    this.retryable = status === undefined || status === 429 || status >= 500;
  }
}

export interface TriageSummary {
  triaged: number;
  failed: number;
}

export function toInput(r: ReleaseWithApp): ReleaseInput {
  return {
    app: r.app_name,
    tag: r.tag,
    title: r.title,
    notes: r.notes,
    url: r.url,
  };
}

/**
 * Triage every untriaged release in the store.
 *
 * A failure is recorded against the release and never propagates: the release
 * renders untriaged ("Not triaged" in the email, unbadged on the dashboard)
 * rather than being dropped, and `triaged_at` stays NULL so a later sweep can
 * pick it up again.
 */
export async function triagePending(
  store: Store,
  provider: Provider,
  opts: { limit?: number; signal?: AbortSignal; retry?: RetryOptions } = {},
): Promise<TriageSummary> {
  const pending = store.untriagedReleases(opts.limit ?? 200);
  if (pending.length === 0) return { triaged: 0, failed: 0 };

  const limit = pLimit(LLM_CONCURRENCY);
  const summary: TriageSummary = { triaged: 0, failed: 0 };

  await Promise.all(
    pending.map((release) =>
      limit(async () => {
        try {
          const result = await callWithRetry(provider, toInput(release), {
            ...opts.retry,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          store.saveTriage(release.id, result);
          summary.triaged++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.saveTriageError(release.id, message);
          summary.failed++;
          console.error(`[triage] release ${release.id} (${release.app_name}): ${message}`);
        }
      }),
    ),
  );

  console.log(
    `[triage] ${summary.triaged} triaged, ${summary.failed} failed via ${provider.name}`,
  );
  return summary;
}

export interface RetryOptions {
  /** Caller's signal — a shutdown or a cancelled job stops the retries. */
  signal?: AbortSignal;
  attempts?: number;
  /** Exponential base. Tests set 0 so they aren't waiting out real backoff. */
  baseDelayMs?: number;
}

/**
 * One release, with backoff on retryable failures.
 *
 * Every attempt gets its own timeout: no job may hang the service, and a single
 * spike request once hung past 110 s where every other run took 3-4 s.
 */
export async function callWithRetry(
  provider: Provider,
  input: ReleaseInput,
  opts: RetryOptions = {},
): Promise<Triage> {
  const outer = opts.signal;
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const baseDelay = opts.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries are sequential by nature
      return await provider.triage(input, signal);
    } catch (err) {
      lastError = err;
      // The caller gave up (shutdown, cancelled job) — stop immediately rather
      // than burning the remaining attempts against a signal that stays aborted.
      if (outer?.aborted) throw err;
      if (err instanceof ProviderError && !err.retryable) throw err;
      if (attempt === attempts) break;

      const delay = baseDelay * 2 ** (attempt - 1);
      // oxlint-disable-next-line no-await-in-loop -- backoff is sequential by nature
      await Bun.sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
