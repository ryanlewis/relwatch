import { afterEach, describe, expect, test } from "bun:test";
import { Store, type ReleaseWithApp, type Verdict } from "../db.js";
import { checkQuiet, runDigest } from "./index.js";
import { clampBytes, renderDigest } from "./render.js";
import { alert, notify, sendDigest } from "./send.js";

const KEY = "test-key";
const BASE = "https://notify.test";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

type FetchHandler = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

function install(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

function requestUrl(input: string | Request | URL): string {
  if (typeof input === "string") return input;
  return input instanceof Request ? input.url : input.href;
}

function stubHubbub(
  responder: (body: Record<string, unknown>) => { status: number; json?: unknown; text?: string },
): Captured[] {
  const calls: Captured[] = [];
  const handler: FetchHandler = (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const parsed: unknown = JSON.parse(raw);
    const body: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    calls.push({
      url: requestUrl(input),
      auth: new Headers(init?.headers).get("authorization") ?? undefined,
      body,
    });
    const r = responder(body);
    const payload = r.json === undefined ? (r.text ?? "") : JSON.stringify(r.json);
    return Promise.resolve(
      new Response(r.status === 204 ? null : payload, {
        status: r.status,
        headers: r.json === undefined ? {} : { "content-type": "application/json" },
      }),
    );
  };
  install(handler);
  return calls;
}

/** fetch that always rejects — a dead socket rather than an HTTP error. */
const failingFetch: FetchHandler = () => Promise.reject(new Error("connect ECONNREFUSED"));

let nextId = 1;
function release(over: Partial<ReleaseWithApp> = {}): ReleaseWithApp {
  return {
    id: nextId++,
    app_id: 1,
    ext_id: "e",
    tag: "v1.0.0",
    title: "v1.0.0",
    url: "https://example.com/r",
    notes: null,
    published_at: "2026-07-26T09:00:00.000Z",
    fetched_at: "2026-07-26T09:05:00.000Z",
    backfilled: false,
    verdict: "major",
    summary: "Something changed.",
    breaking: false,
    highlights: [],
    triaged_at: "2026-07-26T09:06:00.000Z",
    triage_error: null,
    emailed_at: null,
    dismissed_at: null,
    app_name: "Neovim",
    app_kind: "github",
    app_ref: "neovim/neovim",
    app_homepage: null,
    ...over,
  };
}

function storeWithReleases(verdicts: (Verdict | null)[]): Store {
  const store = new Store(":memory:");
  const app = store.upsertApp({ name: "Neovim", kind: "github", ref: "neovim/neovim" });
  for (const [i, verdict] of verdicts.entries()) {
    const row = store.insertRelease({ app_id: app.id, ext_id: `r${i}`, tag: `v1.${i}.0` })!;
    if (verdict) {
      store.saveTriage(row.id, { verdict, summary: `Summary ${i}`, breaking: false, highlights: [] });
    }
  }
  return store;
}

// --- clampBytes ------------------------------------------------------------

describe("clampBytes", () => {
  test("leaves a string under the cap alone", () => {
    expect(clampBytes("hello", 100)).toBe("hello");
  });

  test("truncates to the byte budget", () => {
    expect(clampBytes("x".repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  test("counts bytes, not characters, and never splits a codepoint", () => {
    // Hubbub's caps are byte caps and release titles routinely carry emoji.
    const clamped = clampBytes("🎉".repeat(20), 10); // 4 bytes each
    const encoded = new TextEncoder().encode(clamped);
    expect(encoded.length).toBeLessThanOrEqual(10);
    // A split surrogate pair would re-encode as U+FFFD and the byte length
    // would stop being a clean multiple of 4.
    expect(clamped).not.toContain("�");
    expect(encoded.length % 4).toBe(0);
  });
});

// --- renderDigest ----------------------------------------------------------

describe("renderDigest", () => {
  test("groups major → interesting → maintenance → not triaged", () => {
    const digest = renderDigest([
      release({ verdict: "maintenance", app_name: "Maint" }),
      release({ verdict: null, summary: null, app_name: "Untriaged" }),
      release({ verdict: "major", app_name: "Major" }),
      release({ verdict: "interesting", app_name: "Interesting" }),
    ]);

    const order = ["Major", "Interesting", "Maintenance", "Not triaged"].map((label) =>
      digest.html.indexOf(`>${label}</h2>`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("renders an untriaged release rather than dropping it", () => {
    const digest = renderDigest([release({ verdict: null, summary: null })]);
    expect(digest.html).toContain("Not triaged");
    expect(digest.ids).toHaveLength(1);
  });

  test("shows the breaking flag and highlights", () => {
    const digest = renderDigest([
      release({ breaking: true, highlights: ["First", "Second"] }),
    ]);
    expect(digest.html).toContain("breaking");
    expect(digest.html).toContain("First");
    expect(digest.html).toContain("Second");
  });

  test("escapes upstream content in the HTML part", () => {
    const digest = renderDigest([
      release({
        app_name: "<script>alert(1)</script>",
        summary: "</div><script>alert(1)</script>",
        url: "javascript:alert(1)",
        highlights: ["<b>x</b>"],
      }),
    ]);
    expect(digest.html).not.toContain("<script>alert(1)</script>");
    expect(digest.html).not.toContain("javascript:alert(1)");
    expect(digest.html).toContain("&lt;script&gt;");
  });

  test("titles by count, calling out majors", () => {
    expect(renderDigest([release()]).title).toBe("1 release (1 major)");
    expect(renderDigest([release({ verdict: "maintenance" })]).title).toBe("1 release");
    expect(
      renderDigest([release({ verdict: "maintenance" }), release({ verdict: "maintenance" })]).title,
    ).toBe("2 releases");
  });

  test("the text part summarises rather than repeating the whole digest", () => {
    const digest = renderDigest([
      release({ verdict: "major", app_name: "Neovim", summary: "Major thing." }),
      release({ verdict: "maintenance", app_name: "cli", summary: "Patch thing." }),
    ]);

    expect(digest.message).toContain("2 new releases");
    expect(digest.message).toContain("1 major, 1 maintenance");
    expect(digest.message).toContain("Neovim");
    expect(digest.message).toContain("Major thing.");
    // Maintenance items are counted, not listed.
    expect(digest.message).not.toContain("Patch thing.");
  });

  test("marks a breaking major in the text part", () => {
    const digest = renderDigest([release({ breaking: true })]);
    expect(digest.message).toContain("[breaking]");
  });

  test("keeps the text part under Hubbub's 4 KiB cap", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      release({ app_name: `App${i}`, summary: "A fairly long summary sentence for padding." }),
    );
    const digest = renderDigest(many);
    expect(new TextEncoder().encode(digest.message).length).toBeLessThanOrEqual(4_096);
  });

  test("stays under the byte cap and says how many it dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) => release({ app_name: `App${i}` }));
    const digest = renderDigest(many, { maxHtmlBytes: 6_000 });

    expect(new TextEncoder().encode(digest.html).length).toBeLessThanOrEqual(6_000);
    expect(digest.truncated).toBeGreaterThan(0);
    // Silent truncation is the failure mode this project exists to avoid.
    expect(digest.html).toContain("further release");
    expect(digest.html).toContain("not shown");
    expect(digest.message).toContain("not shown");
  });

  test("ids cover only what was actually included, so the rest roll over", () => {
    const many = Array.from({ length: 40 }, (_, i) => release({ app_name: `App${i}` }));
    const digest = renderDigest(many, { maxHtmlBytes: 6_000 });
    expect(digest.ids).toHaveLength(40 - digest.truncated);
  });

  test("drops the least important releases first when it must drop any", () => {
    const digest = renderDigest(
      [
        release({ verdict: "maintenance", app_name: "DropMe" }),
        release({ verdict: "major", app_name: "KeepMe" }),
      ],
      { maxHtmlBytes: 2_000 },
    );
    if (digest.truncated > 0) {
      expect(digest.html).toContain("KeepMe");
      expect(digest.html).not.toContain("DropMe");
    }
  });

  test("uses the supplied date", () => {
    const digest = renderDigest([release()], { now: new Date("2026-07-26T08:00:00Z") });
    expect(digest.html).toContain("2026-07-26");
  });
});

// --- notify ----------------------------------------------------------------

describe("notify", () => {
  test("posts to /v1/notify with a bearer key", async () => {
    const calls = stubHubbub(() => ({ status: 202 }));
    const result = await notify({ title: "t", message: "m" }, { key: KEY, base: BASE });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(`${BASE}/v1/notify`);
    expect(calls[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body["title"]).toBe("t");
  });

  test("treats 202 as success — the expected answer, not 200", async () => {
    stubHubbub(() => ({ status: 202 }));
    // The response window elapses before iCloud SMTP finishes; 202 means
    // durably spooled.
    expect((await notify({ title: "t", message: "m" }, { key: KEY, base: BASE })).ok).toBe(true);
  });

  test("treats any 2xx as success", async () => {
    const results = await Promise.all(
      [200, 201, 204].map((status) => {
        stubHubbub(() => ({ status }));
        return notify({ title: "t", message: "m" }, { key: KEY, base: BASE });
      }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("reads the per-channel map on a 207 and fails if a channel failed", async () => {
    stubHubbub(() => ({
      status: 207,
      json: { channels: { email: "queued", ntfy: "error: connection refused" } },
    }));

    const result = await notify({ title: "t", message: "m" }, { key: KEY, base: BASE });
    expect(result.status).toBe(207);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ntfy");
    expect(result.channels?.["email"]).toBe("queued");
  });

  test("a 207 where every channel is queued is a success", async () => {
    // Hubbub answers within its response window and finishes delivery behind
    // it, so "queued" is not yet a failure.
    stubHubbub(() => ({ status: 207, json: { channels: { email: "queued" } } }));
    expect((await notify({ title: "t", message: "m" }, { key: KEY, base: BASE })).ok).toBe(true);
  });

  test("tolerates a 207 whose body isn't the shape we expect", async () => {
    stubHubbub(() => ({ status: 207, text: "not json" }));
    const result = await notify({ title: "t", message: "m" }, { key: KEY, base: BASE });
    expect(result.status).toBe(207);
    expect(result.ok).toBe(true); // no failures we can name
  });

  test("reports a 4xx with the body, so a 403 from a bad channel is legible", async () => {
    stubHubbub(() => ({ status: 403, text: "channel not permitted for key" }));
    const result = await notify({ title: "t", message: "m" }, { key: KEY, base: BASE });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("channel not permitted");
  });

  test("reports a transport failure without throwing", async () => {
    install(failingFetch);
    const result = await notify({ title: "t", message: "m" }, { key: KEY, base: BASE });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("reports a missing key file rather than throwing", async () => {
    stubHubbub(() => ({ status: 202 }));
    // No `key` option, and no key file on a laptop — this must be a returned
    // error, not an exception escaping the digest job.
    const result = await notify({ title: "t", message: "m" }, { base: BASE });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBeDefined();
  });
});

describe("sendDigest", () => {
  test("narrows to the email channel and carries both parts", async () => {
    const calls = stubHubbub(() => ({ status: 202 }));
    const digest = renderDigest([release()]);
    await sendDigest(digest, { key: KEY, base: BASE, dryRun: false });

    const body = calls[0]!.body;
    expect(body["channels"]).toEqual(["email"]);
    expect(String(body["html"])).toStartWith("<!doctype");
    expect(body["message"]).toBe(digest.message);
  });

  test("dry run writes a file and sends nothing", async () => {
    const calls = stubHubbub(() => ({ status: 202 }));
    const result = await sendDigest(renderDigest([release()]), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await Bun.file(result.path!).text()).toStartWith("<!doctype");
  });
});

describe("alert", () => {
  test("narrows to ntfy at high priority", async () => {
    const calls = stubHubbub(() => ({ status: 202 }));
    await alert("broken", "details", { key: KEY, base: BASE, dryRun: false });

    // Narrowing to ntfy stops a broken email path swallowing the notice that
    // the email path is broken.
    expect(calls[0]?.body["channels"]).toEqual(["ntfy"]);
    expect(calls[0]?.body["priority"]).toBe("high");
  });

  test("dry run logs instead of sending", async () => {
    const calls = stubHubbub(() => ({ status: 202 }));
    expect((await alert("t", "m", { dryRun: true })).dryRun).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// --- runDigest -------------------------------------------------------------

describe("runDigest", () => {
  test("sends nothing when there is nothing to send", async () => {
    const store = new Store(":memory:");
    const calls = stubHubbub(() => ({ status: 202 }));

    const result = await runDigest(store, { key: KEY, base: BASE, dryRun: false });
    expect(result).toEqual({ sent: 0, skipped: true });
    expect(calls).toHaveLength(0);
    store.close();
  });

  test("sends and marks emailed on a 2xx", async () => {
    const store = storeWithReleases(["major", "maintenance"]);
    stubHubbub(() => ({ status: 202 }));

    const result = await runDigest(store, { key: KEY, base: BASE, dryRun: false });
    expect(result.sent).toBe(2);
    expect(store.digestSet()).toHaveLength(0);
    store.close();
  });

  test("leaves emailed_at unset on failure so tomorrow covers it", async () => {
    const store = storeWithReleases(["major"]);
    stubHubbub((body) => (body["channels"] ? { status: 500, text: "boom" } : { status: 202 }));

    const result = await runDigest(store, { key: KEY, base: BASE, dryRun: false });

    expect(result.sent).toBe(0);
    // The one failure mode that self-heals: never retry, just roll over.
    expect(store.digestSet()).toHaveLength(1);
    store.close();
  });

  test("alerts through ntfy when the send fails", async () => {
    const store = storeWithReleases(["major"]);
    const calls = stubHubbub((body) =>
      Array.isArray(body["channels"]) && body["channels"][0] === "email"
        ? { status: 500, text: "boom" }
        : { status: 202 },
    );

    await runDigest(store, { key: KEY, base: BASE, dryRun: false });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.body["channels"]).toEqual(["ntfy"]);
    expect(calls[1]?.body["priority"]).toBe("high");
    store.close();
  });

  test("survives the alert failing too, rather than throwing out of the job", async () => {
    const store = storeWithReleases(["major"]);
    install(failingFetch); // both the send and the alert are dead

    const result = await runDigest(store, { key: KEY, base: BASE, dryRun: false });

    // A failing alert must not take down the scheduled job; the releases just
    // roll into tomorrow's digest.
    expect(result.sent).toBe(0);
    expect(store.digestSet()).toHaveLength(1);
    store.close();
  });

  test("does not send a release that was dismissed before the digest went out", async () => {
    const store = storeWithReleases(["major", "maintenance"]);
    const [first] = store.digestSet();
    store.dismiss(first!.id);
    stubHubbub(() => ({ status: 202 }));

    const result = await runDigest(store, { key: KEY, base: BASE, dryRun: false });
    expect(result.sent).toBe(1);
    store.close();
  });

  test("never emails backfilled history", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "N", kind: "github", ref: "n/n" });
    store.insertRelease({ app_id: app.id, ext_id: "old", backfilled: true });
    const calls = stubHubbub(() => ({ status: 202 }));

    expect((await runDigest(store, { key: KEY, base: BASE, dryRun: false })).skipped).toBe(true);
    expect(calls).toHaveLength(0);
    store.close();
  });

  test("marks only what the digest contained when the cap truncates", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "N", kind: "github", ref: "n/n" });
    for (let i = 0; i < 40; i++) {
      const row = store.insertRelease({ app_id: app.id, ext_id: `r${i}`, tag: `v${i}` })!;
      store.saveTriage(row.id, {
        verdict: "maintenance",
        summary: "s",
        breaking: false,
        highlights: [],
      });
    }
    stubHubbub(() => ({ status: 202 }));

    const result = await runDigest(store, {
      key: KEY,
      base: BASE,
      dryRun: false,
      maxHtmlBytes: 6_000,
    });

    expect(result.sent).toBeLessThan(40);
    // Whatever was dropped is still pending, so it lands in the next digest.
    expect(store.digestSet()).toHaveLength(40 - result.sent);
    store.close();
  });
});

// --- watchdog --------------------------------------------------------------

describe("checkQuiet", () => {
  test("stays silent on a fresh install with no releases at all", async () => {
    const store = new Store(":memory:");
    const calls = stubHubbub(() => ({ status: 202 }));
    expect(await checkQuiet(store, { key: KEY, base: BASE, dryRun: false })).toBe(false);
    expect(calls).toHaveLength(0);
    store.close();
  });

  test("stays silent while ingestion is recent", async () => {
    const store = storeWithReleases(["major"]);
    const calls = stubHubbub(() => ({ status: 202 }));
    expect(await checkQuiet(store, { key: KEY, base: BASE, dryRun: false })).toBe(false);
    expect(calls).toHaveLength(0);
    store.close();
  });

  test("alerts once ingestion has been silent past the threshold", async () => {
    const store = storeWithReleases(["major"]);
    const calls = stubHubbub(() => ({ status: 202 }));

    // A silently broken poller looks exactly like a quiet week from outside.
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await checkQuiet(store, { key: KEY, base: BASE, dryRun: false, now: later })).toBe(true);
    expect(calls[0]?.body["channels"]).toEqual(["ntfy"]);
    store.close();
  });
});
