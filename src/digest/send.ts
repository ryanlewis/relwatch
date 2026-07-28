// Delivery through hubbub (github.com/ryanlewis/hubbub), against the contract in
// its README.
//
// The rule that shapes everything here: hubbub's delivery is at-least-once with no
// idempotency key, so a client retry is a duplicate digest in the operator's
// inbox. A timeout therefore leaves emailed_at unset and lets tomorrow's digest
// cover it — the one failure mode that self-heals. Never retry a send.
import { readFileSync } from "node:fs";
import { DRY_RUN, HUBBUB_BASE, HUBBUB_KEY_FILE } from "../config.js";
import type { Digest } from "./render.js";

export interface SendResult {
  ok: boolean;
  status: number;
  /** Per-channel outcomes from a 207, when Hubbub reports a partial result. */
  channels?: Record<string, string>;
  error?: string;
  /** True when RW_DRY_RUN suppressed the send. */
  dryRun?: boolean;
  /** Where the dry-run digest was written. */
  path?: string;
}

/** Hubbub's response window (2.5s default) plus room for the round trip. */
const SEND_TIMEOUT_MS = 10_000;

export function readHubbubKey(path = HUBBUB_KEY_FILE): string {
  const key = readFileSync(path, "utf8").trim();
  if (key === "") throw new Error(`empty Hubbub key at ${path}`);
  return key;
}

export interface NotifyPayload {
  title: string;
  message: string;
  html?: string;
  priority?: "low" | "default" | "high" | "urgent";
  tags?: string[];
  /** Narrows delivery. Naming a channel the key doesn't hold is a 403. */
  channels?: string[];
}

/**
 * POST to Hubbub. Any 2xx is success: the response window elapses before iCloud
 * SMTP finishes, so 202 ("durably spooled") is the expected answer, not 200.
 */
export async function notify(
  payload: NotifyPayload,
  opts: { key?: string; base?: string; signal?: AbortSignal } = {},
): Promise<SendResult> {
  const base = opts.base ?? HUBBUB_BASE;
  // RW_HUBBUB_BASE has no default, so an unconfigured deployment says so plainly
  // rather than failing later as an opaque fetch error on a relative URL.
  if (base === "") {
    return { ok: false, status: 0, error: "RW_HUBBUB_BASE is not set" };
  }

  let key: string;
  try {
    key = opts.key ?? readHubbubKey();
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await fetch(`${base}/v1/notify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: opts.signal ?? AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    // 207 means some channels succeeded and some didn't; the status alone is
    // not the answer, so the per-channel map has to be read.
    if (res.status === 207) {
      const channels = await readChannelMap(res);
      const failed = Object.entries(channels).filter(([, state]) => !isDelivered(state));
      return {
        ok: failed.length === 0,
        status: 207,
        channels,
        ...(failed.length > 0
          ? { error: `channels failed: ${failed.map(([name]) => name).join(", ")}` }
          : {}),
      };
    }

    if (res.ok) return { ok: true, status: res.status };

    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: `Hubbub ${res.status}: ${body.slice(0, 300)}` };
  } catch (err) {
    // Includes the timeout. The caller must NOT retry — see the file header.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  }
}

async function readChannelMap(res: Response): Promise<Record<string, string>> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return {};
    const raw: unknown = "channels" in body ? body.channels : body;
    if (typeof raw !== "object" || raw === null) return {};

    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      out[name] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return out;
  } catch {
    return {};
  }
}

function isDelivered(state: string): boolean {
  // "queued" counts: Hubbub answers within its response window and finishes
  // delivery behind it, so anything still in flight is not yet a failure.
  return /^(ok|sent|delivered|queued|accepted)/i.test(state);
}

/**
 * Send a digest. Returns the result; the caller marks emailed_at only on ok.
 * Under RW_DRY_RUN the digest is written to a file and nothing is sent.
 */
export async function sendDigest(
  digest: Digest,
  opts: { key?: string; base?: string; dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<SendResult> {
  const dryRun = opts.dryRun ?? DRY_RUN;
  if (dryRun) {
    const path = `/tmp/relwatch-digest-${Date.now()}.html`;
    await Bun.write(path, digest.html);
    console.log(`[digest] dry run — wrote ${path}\n${digest.message}`);
    return { ok: true, status: 0, dryRun: true, path };
  }

  return await notify(
    {
      title: `Release digest — ${digest.title}`,
      message: digest.message,
      html: digest.html,
      tags: ["releases"],
      channels: ["email"],
    },
    opts,
  );
}

/**
 * Failure alerting. Narrowing to ntfy keeps a broken email path from swallowing
 * the notice that the email path is broken.
 *
 * Like `notify`, this reports failure by returning rather than throwing — it is
 * called from the failure path of a scheduled job, and an alert that throws
 * would turn "the digest failed" into "the service crashed".
 */
export async function alert(
  title: string,
  message: string,
  opts: { key?: string; base?: string; dryRun?: boolean } = {},
): Promise<SendResult> {
  if (opts.dryRun ?? DRY_RUN) {
    console.error(`[alert] dry run — ${title}: ${message}`);
    return { ok: true, status: 0, dryRun: true };
  }
  return await notify(
    { title, message, priority: "high", channels: ["ntfy"], tags: ["relwatch"] },
    opts,
  );
}
