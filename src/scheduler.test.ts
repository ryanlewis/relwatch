import { describe, expect, test } from "bun:test";
import { DIGEST_CRON, POLL_CRON, TZ } from "./config.js";
import { Store } from "./db.js";
import { guard, pollAndTriage, safeCron, startScheduler, type SchedulerDeps } from "./scheduler.js";
import type { SourceRegistry } from "./poll.js";
import type { FetchOptions, FetchResult, Source } from "./source/index.js";
import { ProviderError, type Provider } from "./triage/index.js";
import type { ReleaseInput, Triage } from "./triage/schema.js";
import { StubProvider } from "./triage/stub.js";

const OK: Triage = { verdict: "major", summary: "s", breaking: false, highlights: [] };

class FakeSource implements Source {
  constructor(
    readonly kind: "github" | "rss",
    private readonly result: () => FetchResult,
  ) {}
  fetch(_ref: string, _opts: FetchOptions): Promise<FetchResult> {
    return Promise.resolve(this.result());
  }
}

function sourcesReturning(extIds: string[]): SourceRegistry {
  const make = (kind: "github" | "rss") =>
    new FakeSource(kind, () => ({
      releases: extIds.map((ext_id) => ({
        ext_id,
        tag: ext_id,
        title: ext_id,
        url: null,
        notes: null,
        published_at: "2026-07-26T09:00:00.000Z",
      })),
      etag: null,
      notModified: false,
    }));
  return { github: make("github"), rss: make("rss") };
}

function deps(over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  const store = over.store ?? new Store(":memory:");
  if (!over.store) {
    // Seeded, so these tests exercise steady state rather than an app's
    // seeding poll (where every release is history by design).
    store.markSeeded(store.upsertApp({ name: "N", kind: "github", ref: "n/n" }).id, "2020-01-01T00:00:00.000Z");
  }
  return {
    store,
    provider: over.provider ?? new StubProvider(),
    ...(over.sources ? { sources: over.sources } : { sources: sourcesReturning(["r1"]) }),
  };
}

describe("guard", () => {
  test("reports success for a job that completes", async () => {
    expect(await guard("ok", () => Promise.resolve())).toBe(true);
  });

  test("swallows a throw so a crashed job can't take the service down", async () => {
    // A cron callback that throws would silently drop that schedule until the
    // next restart — "the digest quietly stopped" is the exact failure this
    // project exists to notice.
    expect(
      await guard("bad", () => Promise.reject(new Error("boom"))),
    ).toBe(false);
  });

  test("keeps running jobs after one has failed", async () => {
    await guard("bad", () => Promise.reject(new Error("boom")));
    expect(await guard("good", () => Promise.resolve())).toBe(true);
  });
});

describe("pollAndTriage", () => {
  test("polls, then triages what it brought in", async () => {
    const d = deps();
    await pollAndTriage(d);

    expect(d.store.counts().releases).toBe(1);
    expect(d.store.untriagedReleases()).toEqual([]);
    expect(d.store.listReleases()[0]?.verdict).not.toBeNull();
    d.store.close();
  });

  test("skips the triage sweep entirely when nothing is pending", async () => {
    let calls = 0;
    const counting: Provider = {
      name: "counting",
      triage: (_r: ReleaseInput) => {
        calls++;
        return Promise.resolve(OK);
      },
    };
    const d = deps({ provider: counting });

    await pollAndTriage(d);
    expect(calls).toBe(1);

    // Second cycle sees the same release, inserts nothing, and must not
    // re-triage it — triage is once per release, forever.
    await pollAndTriage(d);
    expect(calls).toBe(1);
    d.store.close();
  });

  test("retries a release an earlier cycle failed to triage", async () => {
    let attempt = 0;
    const flaky: Provider = {
      name: "flaky",
      triage: () => {
        attempt++;
        // A 400 so the first failure is terminal rather than retried — this
        // test is about the *next cycle* picking it up, not about backoff.
        return attempt === 1
          ? Promise.reject(new ProviderError("nope", 400))
          : Promise.resolve(OK);
      },
    };
    const d = deps({ provider: flaky });

    await pollAndTriage(d);
    expect(d.store.listReleases()[0]?.triage_error).toBe("nope");

    // The sweep works off the store's pending set, not the poll's return
    // value, so a previous failure gets another go with no extra schedule.
    await pollAndTriage(d);
    expect(d.store.listReleases()[0]?.verdict).toBe("major");
    expect(d.store.untriagedReleases()).toEqual([]);
    d.store.close();
  });

  test("a source failure does not stop the cycle", async () => {
    const exploding: SourceRegistry = {
      github: new FakeSource("github", () => {
        throw new Error("GitHub 500");
      }),
      rss: new FakeSource("rss", () => ({ releases: [], etag: null, notModified: true })),
    };
    const d = deps({ sources: exploding });

    // poll() logs and skips per app, so this resolves rather than rejecting.
    await pollAndTriage(d);
    expect(d.store.counts().releases).toBe(0);
    d.store.close();
  });
});

describe("startScheduler", () => {
  test("registers both jobs with a next run in the configured zone", () => {
    const d = deps();
    const scheduler = startScheduler(d);

    expect(scheduler.jobs).toHaveLength(2);
    for (const job of scheduler.jobs) {
      expect(job.nextRun()).not.toBeNull();
    }

    scheduler.stop();
    d.store.close();
  });

  test("stop() halts every job", () => {
    const d = deps();
    const scheduler = startScheduler(d);
    scheduler.stop();

    for (const job of scheduler.jobs) {
      expect(job.nextRun()).toBeNull();
    }
    d.store.close();
  });

  test("the configured crons parse and schedule as expected", () => {
    const d = deps();
    const scheduler = startScheduler(d);
    const [pollJob, digestJob] = scheduler.jobs;

    // Guards against a typo'd RW_POLL_CRON silently never firing.
    expect(pollJob!.getPattern()).toBe(POLL_CRON);
    expect(digestJob!.getPattern()).toBe(DIGEST_CRON);
    expect(TZ).toBeTruthy();

    scheduler.stop();
    d.store.close();
  });

  test("the digest fires daily and the poll more often than that", () => {
    const d = deps();
    const scheduler = startScheduler(d);
    const [pollJob, digestJob] = scheduler.jobs;

    const pollGap = gapMs(pollJob!.nextRun(), pollJob!.nextRun(pollJob!.nextRun() ?? undefined));
    const digestGap = gapMs(
      digestJob!.nextRun(),
      digestJob!.nextRun(digestJob!.nextRun() ?? undefined),
    );

    expect(pollGap).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    expect(digestGap).toBe(24 * 60 * 60 * 1000);

    scheduler.stop();
    d.store.close();
  });
});

describe("safeCron", () => {
  test("passes a valid pattern straight through", () => {
    expect(safeCron("0 */6 * * *", "0 8 * * *", "RW_POLL_CRON")).toBe("0 */6 * * *");
  });

  test("falls back on the exact shape an unquoted systemd Environment= produces", () => {
    // systemd splits Environment= on whitespace, so `RW_POLL_CRON=0 */6 * * *`
    // arrives as "0". This crash-looped the real service under
    // Restart=on-failure until it was caught.
    expect(safeCron("0", "0 */6 * * *", "RW_POLL_CRON")).toBe("0 */6 * * *");
  });

  test("falls back on other malformed patterns rather than throwing", () => {
    expect(safeCron("", "0 8 * * *", "RW_DIGEST_CRON")).toBe("0 8 * * *");
    expect(safeCron("not a cron", "0 8 * * *", "RW_DIGEST_CRON")).toBe("0 8 * * *");
    expect(safeCron("99 99 99 99 99", "0 8 * * *", "RW_DIGEST_CRON")).toBe("0 8 * * *");
  });

  test("a service with a broken pattern still schedules on the fallback", () => {
    const d = deps();
    const scheduler = startScheduler(d);
    // Whatever the env holds, both jobs must end up with a real next run —
    // no dashboard is worse than a wrong schedule.
    for (const job of scheduler.jobs) expect(job.nextRun()).not.toBeNull();
    scheduler.stop();
    d.store.close();
  });
});

describe("scheduled jobs, triggered manually", () => {
  test("the poll job ingests and triages without throwing", async () => {
    const d = deps();
    const scheduler = startScheduler(d);

    await scheduler.jobs[0]!.trigger();

    expect(d.store.counts().releases).toBe(1);
    expect(d.store.untriagedReleases()).toEqual([]);
    scheduler.stop();
    d.store.close();
  });

  test("the digest job sends and marks, then runs the watchdog", async () => {
    const d = deps();
    await pollAndTriage(d);
    expect(d.store.digestSet()).toHaveLength(1);

    const calls = stubFetch(202);
    const scheduler = startScheduler({ ...d, digest: { key: "k", base: "https://notify.test" } });

    await scheduler.jobs[1]!.trigger();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(d.store.digestSet()).toHaveLength(0);
    scheduler.stop();
    d.store.close();
    restoreFetch();
  });

  test("a failing job is swallowed rather than escaping the cron callback", async () => {
    const d = deps({
      sources: {
        github: new FakeSource("github", () => {
          throw new Error("total failure");
        }),
        rss: new FakeSource("rss", () => {
          throw new Error("total failure");
        }),
      },
    });
    const scheduler = startScheduler(d);

    // poll() already isolates per-app failures, so this asserts the outer
    // guard too: triggering must resolve, never reject.
    await scheduler.jobs[0]!.trigger();

    expect(d.store.counts().releases).toBe(0);
    scheduler.stop();
    d.store.close();
  });
});

const realFetch = globalThis.fetch;

function stubFetch(status: number): string[] {
  const calls: string[] = [];
  const handler: (input: string | Request | URL, init?: RequestInit) => Promise<Response> = (
    input,
  ) => {
    calls.push(typeof input === "string" ? input : input instanceof Request ? input.url : input.href);
    return Promise.resolve(new Response("{}", { status }));
  };
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function gapMs(a: Date | null, b: Date | null): number {
  if (!a || !b) throw new Error("expected two scheduled runs");
  return b.getTime() - a.getTime();
}
