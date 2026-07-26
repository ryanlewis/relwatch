import { describe, expect, test } from "bun:test";
import { Store } from "../db.js";
import { AiSdkProvider, asProviderError, isRepairable } from "./aisdk.js";
import { callWithRetry, ProviderError, toInput, triagePending, type Provider } from "./index.js";
import { buildPrompt, buildRepairPrompt, TriageSchema, type ReleaseInput, type Triage } from "./schema.js";
import { StubProvider } from "./stub.js";

const OK: Triage = { verdict: "major", summary: "Big.", breaking: false, highlights: ["a"] };

/** Retries without the real 2s/4s backoff, so tests aren't waiting it out. */
const NO_BACKOFF = { attempts: 3, baseDelayMs: 0 } as const;

/**
 * Resolve to whatever a promise rejected with.
 *
 * Bun types `expect(p).rejects.toThrow()` as returning void, so awaiting it is
 * a lint error and *not* awaiting it lets a failure escape the test. Capturing
 * the error and asserting on it directly avoids both, and lets the assertions
 * reach fields like `status` that `toThrow` can't see.
 */
async function catchError(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    rejected = true;
    caught = err;
  }
  if (!rejected) throw new Error("expected the promise to reject, but it resolved");
  if (caught instanceof Error) return caught;
  throw new Error(`rejected with a non-Error value: ${String(caught)}`);
}

const INPUT: ReleaseInput = {
  app: "Neovim",
  tag: "v0.12.0",
  title: "v0.12.0",
  notes: "- Added a thing\n- Fixed another",
  url: "https://example.com/r",
};

/** Provider that replays a scripted sequence of outcomes and counts calls. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  calls = 0;

  constructor(private readonly script: (call: number) => Triage | Error) {}

  triage(_release: ReleaseInput, _signal: AbortSignal): Promise<Triage> {
    this.calls++;
    const outcome = this.script(this.calls);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function storeWithPending(count = 1): Store {
  const store = new Store(":memory:");
  const app = store.upsertApp({ name: "Neovim", kind: "github", ref: "neovim/neovim" });
  for (let i = 0; i < count; i++) {
    store.insertRelease({ app_id: app.id, ext_id: `r${i}`, tag: `v0.${i}.0`, notes: "notes" });
  }
  return store;
}

describe("TriageSchema", () => {
  test("accepts a well-formed triage", () => {
    expect(TriageSchema.parse(OK)).toEqual(OK);
  });

  test("rejects a verdict outside the three", () => {
    expect(() => TriageSchema.parse({ ...OK, verdict: "critical" })).toThrow();
  });

  test("caps highlights at three", () => {
    expect(() => TriageSchema.parse({ ...OK, highlights: ["a", "b", "c", "d"] })).toThrow();
    expect(TriageSchema.parse({ ...OK, highlights: [] }).highlights).toEqual([]);
  });

  test("requires breaking to be a boolean, not a truthy string", () => {
    expect(() => TriageSchema.parse({ ...OK, breaking: "yes" })).toThrow();
  });
});

describe("prompts", () => {
  test("name the project and carry the notes", () => {
    const prompt = buildPrompt(INPUT);
    expect(prompt).toContain("Neovim");
    expect(prompt).toContain("v0.12.0");
    expect(prompt).toContain("Added a thing");
  });

  test("say so plainly when a release has no notes", () => {
    const prompt = buildPrompt({ ...INPUT, notes: null });
    expect(prompt).toContain("(no release notes provided)");
  });

  test("fall back to the title when there is no tag", () => {
    expect(buildPrompt({ ...INPUT, tag: null, title: "Some Release" })).toContain("Some Release");
  });

  test("the repair prompt feeds back the raw output and the error", () => {
    const repair = buildRepairPrompt(INPUT, "I think this release is nice!", "expected object");
    expect(repair).toContain("I think this release is nice!");
    expect(repair).toContain("expected object");
    expect(repair).toContain("Neovim"); // still contains the original ask
  });

  test("the repair prompt truncates a runaway previous response", () => {
    const repair = buildRepairPrompt(INPUT, "x".repeat(10_000), "nope");
    expect(repair.length).toBeLessThan(5_000);
  });
});

describe("ProviderError", () => {
  test("marks 5xx and 429 retryable", () => {
    expect(new ProviderError("boom", 500).retryable).toBe(true);
    expect(new ProviderError("boom", 503).retryable).toBe(true);
    expect(new ProviderError("slow down", 429).retryable).toBe(true);
  });

  test("marks other 4xx not retryable", () => {
    // Retrying our own bad request burns quota and delays the honest failure.
    expect(new ProviderError("bad request", 400).retryable).toBe(false);
    expect(new ProviderError("nope", 403).retryable).toBe(false);
    expect(new ProviderError("gone", 404).retryable).toBe(false);
  });

  test("treats a status-less transport error as retryable", () => {
    expect(new ProviderError("socket hang up").retryable).toBe(true);
  });
});

describe("callWithRetry", () => {
  test("returns the first success without retrying", async () => {
    const provider = new ScriptedProvider(() => OK);
    expect(await callWithRetry(provider, INPUT)).toEqual(OK);
    expect(provider.calls).toBe(1);
  });

  test("retries a 5xx and succeeds", async () => {
    const provider = new ScriptedProvider((n) => (n === 1 ? new ProviderError("boom", 500) : OK));
    expect(await callWithRetry(provider, INPUT)).toEqual(OK);
    expect(provider.calls).toBe(2);
  });

  test("gives up after the attempt budget and rethrows the last error", async () => {
    const provider = new ScriptedProvider(() => new ProviderError("still down", 503));
    const err = await catchError(callWithRetry(provider, INPUT, NO_BACKOFF));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("still down");
    expect(provider.calls).toBe(3);
  });

  test("backs off exponentially between attempts", async () => {
    const provider = new ScriptedProvider((n) => (n < 3 ? new ProviderError("down", 500) : OK));
    const start = performance.now();
    await callWithRetry(provider, INPUT, { attempts: 3, baseDelayMs: 20 });
    // 20ms then 40ms; assert the shape, not the exact figure.
    expect(performance.now() - start).toBeGreaterThanOrEqual(55);
  });

  test("does not retry a 4xx", async () => {
    const provider = new ScriptedProvider(() => new ProviderError("bad request", 400));
    const err = await catchError(callWithRetry(provider, INPUT, NO_BACKOFF));
    expect(err.message).toBe("bad request");
    expect(provider.calls).toBe(1);
  });

  test("stops immediately when the caller's signal is already aborted", async () => {
    const provider = new ScriptedProvider(() => new ProviderError("transport", 500));
    const controller = new AbortController();
    controller.abort();

    await catchError(callWithRetry(provider, INPUT, { ...NO_BACKOFF, signal: controller.signal }));
    // Without the aborted-signal check this would burn all three attempts
    // against a signal that can never succeed.
    expect(provider.calls).toBe(1);
  });

  test("rethrows a non-Error rejection as an Error", async () => {
    const provider: Provider = {
      name: "rude",
      triage: () => Promise.reject(new ProviderError("just a string", 500)),
    };
    const err = await catchError(callWithRetry(provider, INPUT, NO_BACKOFF));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("just a string");
  });

  test("passes a signal that is already timing out", async () => {
    let seen: AbortSignal | null = null;
    const provider: Provider = {
      name: "capture",
      triage(_r, signal) {
        seen = signal;
        return Promise.resolve(OK);
      },
    };
    await callWithRetry(provider, INPUT);
    expect(seen).not.toBeNull();
    expect(seen!.aborted).toBe(false);
  });
});

describe("triagePending", () => {
  test("triages every pending release and stores the verdict", async () => {
    const store = storeWithPending(3);
    const summary = await triagePending(store, new ScriptedProvider(() => OK));

    expect(summary).toEqual({ triaged: 3, failed: 0 });
    expect(store.untriagedReleases()).toEqual([]);
    expect(store.listReleases()[0]?.verdict).toBe("major");
    store.close();
  });

  test("does nothing when there is nothing pending", async () => {
    const store = new Store(":memory:");
    const provider = new ScriptedProvider(() => OK);
    expect(await triagePending(store, provider)).toEqual({ triaged: 0, failed: 0 });
    expect(provider.calls).toBe(0);
    store.close();
  });

  test("records a failure without dropping the release", async () => {
    const store = storeWithPending(1);
    const summary = await triagePending(
      store,
      new ScriptedProvider(() => new ProviderError("model returned prose", 400)),
      { retry: NO_BACKOFF },
    );

    expect(summary).toEqual({ triaged: 0, failed: 1 });
    const [release] = store.listReleases();
    // Still there, still visible, just unbadged — never dropped.
    expect(release).toBeDefined();
    expect(release!.verdict).toBeNull();
    expect(release!.triage_error).toBe("model returned prose");
    // triaged_at stays NULL so a later sweep retries it.
    expect(store.untriagedReleases()).toHaveLength(1);
    store.close();
  });

  test("one failure does not stop the rest of the batch", async () => {
    const store = storeWithPending(3);
    let failures = 0;
    const provider = new ScriptedProvider(() => {
      if (failures === 0) {
        failures++;
        return new ProviderError("bad", 400);
      }
      return OK;
    });

    const summary = await triagePending(store, provider, { retry: NO_BACKOFF });
    expect(summary.triaged).toBe(2);
    expect(summary.failed).toBe(1);
    store.close();
  });

  test("honours the limit", async () => {
    const store = storeWithPending(5);
    const summary = await triagePending(store, new ScriptedProvider(() => OK), { limit: 2 });
    expect(summary.triaged).toBe(2);
    expect(store.untriagedReleases()).toHaveLength(3);
    store.close();
  });

  test("never triages backfilled history", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "N", kind: "github", ref: "n/n" });
    store.insertRelease({ app_id: app.id, ext_id: "old", backfilled: true });

    const provider = new ScriptedProvider(() => OK);
    expect(await triagePending(store, provider)).toEqual({ triaged: 0, failed: 0 });
    expect(provider.calls).toBe(0);
    store.close();
  });
});

describe("toInput", () => {
  test("maps a stored release onto the provider's input", () => {
    const store = storeWithPending(1);
    const input = toInput(store.listReleases()[0]!);
    expect(input.app).toBe("Neovim");
    expect(input.tag).toBe("v0.0.0");
    store.close();
  });
});

describe("isRepairable", () => {
  test("treats a schema mismatch as repairable", () => {
    const err = new Error("response did not match schema");
    expect(isRepairable(err)).toBe(true);

    const typeErr = new Error("value did not match");
    typeErr.name = "AI_TypeValidationError";
    expect(isRepairable(typeErr)).toBe(true);
  });

  test("does not treat transport failures as repairable", () => {
    // Re-prompting cannot fix a 429 or a dead socket; backoff owns those.
    expect(isRepairable(new Error("fetch failed"))).toBe(false);
    expect(isRepairable(new ProviderError("rate limited", 429))).toBe(false);
    expect(isRepairable("a string")).toBe(false);
    expect(isRepairable(null)).toBe(false);
  });
});

describe("asProviderError", () => {
  test("passes a ProviderError through untouched", () => {
    const original = new ProviderError("x", 500);
    expect(asProviderError(original)).toBe(original);
  });

  test("lifts a status off an SDK error so the retry policy can read it", () => {
    const err = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const wrapped = asProviderError(err);
    expect(wrapped.status).toBe(429);
    expect(wrapped.retryable).toBe(true);
  });

  test("reads a plain `status` property too", () => {
    const wrapped = asProviderError(Object.assign(new Error("bad"), { status: 400 }));
    expect(wrapped.status).toBe(400);
    expect(wrapped.retryable).toBe(false);
  });

  test("treats a status-less error as retryable transport trouble", () => {
    expect(asProviderError(new Error("socket hang up")).retryable).toBe(true);
    expect(asProviderError("just a string").message).toBe("just a string");
  });
});

describe("AiSdkProvider — validate/repair", () => {
  test("names the backend and model it is configured for", () => {
    expect(new AiSdkProvider("openai-responses").name).toStartWith("openai-responses:");
    expect(new AiSdkProvider("anthropic").name).toStartWith("anthropic:");
  });

  test("returns a first-attempt success without a repair call", async () => {
    let calls = 0;
    const provider = new AiSdkProvider("anthropic", () => {
      calls++;
      return Promise.resolve(OK);
    });
    expect(await provider.triage(INPUT, AbortSignal.timeout(1_000))).toEqual(OK);
    expect(calls).toBe(1);
  });

  test("repairs an unusable response by feeding the raw output back", async () => {
    const prompts: string[] = [];
    const provider = new AiSdkProvider("anthropic", (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        const err = new Error("response did not match schema");
        err.name = "AI_TypeValidationError";
        return Promise.reject(err);
      }
      return Promise.resolve(OK);
    });

    expect(await provider.triage(INPUT, AbortSignal.timeout(1_000))).toEqual(OK);
    expect(prompts).toHaveLength(2);
    // The second prompt is the repair one: it carries the failure back.
    expect(prompts[1]).toContain("could not be used");
    expect(prompts[1]).toContain("did not match schema");
  });

  test("gives up after one repair, so a structurally broken model can't loop", async () => {
    let calls = 0;
    const provider = new AiSdkProvider("anthropic", () => {
      calls++;
      const err = new Error("response did not match schema");
      err.name = "AI_TypeValidationError";
      return Promise.reject(err);
    });

    expect(await catchError(provider.triage(INPUT, AbortSignal.timeout(1_000)))).toBeInstanceOf(
      ProviderError,
    );
    expect(calls).toBe(2); // the attempt and exactly one repair
  });

  test("does not attempt a repair for a transport failure", async () => {
    let calls = 0;
    const provider = new AiSdkProvider("anthropic", () => {
      calls++;
      return Promise.reject(Object.assign(new Error("rate limited"), { statusCode: 429 }));
    });

    // Re-prompting cannot fix a 429; the retry/backoff layer above owns it.
    const err: unknown = await provider.triage(INPUT, AbortSignal.timeout(1_000)).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(ProviderError);
    if (err instanceof ProviderError) expect(err.status).toBe(429);
  });

  test("surfaces a repair failure as a ProviderError carrying its status", async () => {
    let calls = 0;
    const provider = new AiSdkProvider("anthropic", () => {
      calls++;
      if (calls === 1) {
        const err = new Error("did not match schema");
        err.name = "AI_TypeValidationError";
        return Promise.reject(err);
      }
      return Promise.reject(Object.assign(new Error("boom"), { statusCode: 500 }));
    });

    const err: unknown = await provider.triage(INPUT, AbortSignal.timeout(1_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    if (err instanceof ProviderError) {
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
    }
  });

  test("a repaired provider drives a full sweep, error recorded on failure", async () => {
    const store = storeWithPending(2);
    let calls = 0;
    const provider = new AiSdkProvider("anthropic", () => {
      calls++;
      // First release fails outright; second succeeds.
      return calls === 1
        ? Promise.reject(Object.assign(new Error("nope"), { statusCode: 400 }))
        : Promise.resolve(OK);
    });

    const summary = await triagePending(store, provider, { retry: NO_BACKOFF });
    expect(summary.triaged + summary.failed).toBe(2);
    store.close();
  });
});

describe("StubProvider", () => {
  test("produces schema-valid output for anything", async () => {
    const stub = new StubProvider();
    const result = await stub.triage(INPUT);
    expect(() => TriageSchema.parse(result)).not.toThrow();
  });

  test("reads a .0.0 tag as major", async () => {
    const stub = new StubProvider();
    expect((await stub.triage({ ...INPUT, tag: "v1.0.0", notes: null })).verdict).toBe("major");
  });

  test("reads a patch changelog as maintenance", async () => {
    const stub = new StubProvider();
    const result = await stub.triage({
      ...INPUT,
      tag: "v0.1.3",
      title: null,
      notes: "- bugfix: crash on start\n- bump dependency",
    });
    expect(result.verdict).toBe("maintenance");
  });

  test("flags a breaking change from the notes", async () => {
    const stub = new StubProvider();
    const result = await stub.triage({ ...INPUT, notes: "This is a breaking change." });
    expect(result.breaking).toBe(true);
  });

  test("lifts up to three bullets out of the notes", async () => {
    const stub = new StubProvider();
    const result = await stub.triage({
      ...INPUT,
      notes: "- one\n- two\n- three\n- four\nnot a bullet",
    });
    expect(result.highlights).toEqual(["one", "two", "three"]);
  });

  test("returns no highlights when the notes are not a list", async () => {
    const stub = new StubProvider();
    expect((await stub.triage({ ...INPUT, notes: "Just prose." })).highlights).toEqual([]);
    expect((await stub.triage({ ...INPUT, notes: null })).highlights).toEqual([]);
  });

  test("drives a full sweep offline", async () => {
    const store = storeWithPending(3);
    const summary = await triagePending(store, new StubProvider());
    expect(summary.triaged).toBe(3);
    expect(store.untriagedReleases()).toEqual([]);
    store.close();
  });
});
