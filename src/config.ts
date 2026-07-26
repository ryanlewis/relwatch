// Central configuration. Every tunable lives here, and every one is an RW_* env var
// so the systemd unit is the single place deployment differs from a local run.
//
// See DESIGN.md §7 for the canonical table. Names not in that table are marked
// "(not in DESIGN §7)" — they exist because the implementation needed them.
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Parse an integer env var, falling back to `fallback` when unset or garbage.
 *
 * Lifted from hn-summaries, where the reasoning is worth repeating: a plain
 * `Number(process.env.X ?? default)` turns a typo into NaN and lets it propagate.
 * That is tolerable where NaN fails loudly, but the numeric knobs here fail
 * quietly and badly — a NaN concurrency makes p-limit throw on every poll cycle,
 * a NaN byte cap makes every digest look oversized. Both are one typo away in a
 * systemd unit.
 *
 * Empty/whitespace-only counts as unset: `Number("")` is 0, so a bare
 * `Environment=RW_LLM_CONCURRENCY=` would otherwise read as a deliberate 0.
 */
export function intEnv(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Parse a duration written as `90s`, `2m`, `500ms`, or a bare integer (ms).
 * Same fallback-on-garbage contract as intEnv: a malformed timeout must not
 * become NaN, because `AbortSignal.timeout(NaN)` aborts immediately and would
 * turn every LLM call into an instant failure.
 */
export function durationEnv(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) return fallbackMs;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.floor(value * mult);
}

/** `0`/`false`/unset are false; anything else is true. */
export function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return fallback;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// --- LLM backend -----------------------------------------------------------
// Both hostnames are internal-only DNS, resolvable from #chatgpt-tagged exe.dev
// VMs. Neither takes an API key: the integrations authenticate the VM itself,
// which is why relwatch keeps no LLM credentials on disk.
//
//   openai-responses — chatgpt.int.exe.xyz, backed by the ChatGPT subscription
//                      (billed outside the exe.dev token allocation). Responses
//                      API only: needs stream:true + store:false, rejects
//                      max_output_tokens. See DESIGN §2.
//   anthropic        — llm.int.exe.xyz, metered against the $20/mo allocation.
export const BACKENDS = ["openai-responses", "anthropic"] as const;
export type Backend = (typeof BACKENDS)[number];

export function isBackend(v: string): v is Backend {
  return BACKENDS.some((b) => b === v);
}

const rawBackend = (process.env.RW_BACKEND ?? "openai-responses").trim();
export const BACKEND: Backend = isBackend(rawBackend) ? rawBackend : "openai-responses";

// Path-prefixed routing (/openai/v1, /anthropic/v1) — it forces the provider,
// takes plain model names, and avoids SDKs mangling a `provider/` prefix.
export const OPENAI_BASE =
  process.env.RW_OPENAI_BASE ?? "https://chatgpt.int.exe.xyz/openai/v1";
export const OPENAI_MODEL = process.env.RW_OPENAI_MODEL ?? "gpt-5.5";
export const ANTHROPIC_BASE =
  process.env.RW_ANTHROPIC_BASE ?? "https://llm.int.exe.xyz/anthropic/v1";
export const ANTHROPIC_MODEL = process.env.RW_ANTHROPIC_MODEL ?? "claude-opus-5";

export const LLM_CONCURRENCY = intEnv(process.env.RW_LLM_CONCURRENCY, 4, 1);
// A single transient spike request hung past 110 s where every other run took
// 3-4 s. No job may hang the service, so every LLM call carries this abort.
export const LLM_TIMEOUT_MS = durationEnv(process.env.RW_TIMEOUT, 90_000);
// Retry only on 5xx/429 — a 4xx is our bug and retrying just burns quota.
export const RETRY_ATTEMPTS = intEnv(process.env.RW_RETRY_ATTEMPTS, 3, 1);
export const RETRY_BASE_DELAY_MS = intEnv(process.env.RW_RETRY_BASE_DELAY_MS, 2_000, 0);

// --- Store -----------------------------------------------------------------
export const DB_PATH = expandHome(
  process.env.RW_DB ?? "~/.local/share/relwatch/relwatch.db",
);

// --- Web -------------------------------------------------------------------
export const PORT = intEnv(process.env.RW_PORT, 8000, 1);

/**
 * (not in DESIGN §7) Sub-path the dashboard is served under, because the target
 * deployment mounts it at `relwatch.example.com` rather than a bare domain.
 *
 * Normalised to either "" (root) or a leading-slash, no-trailing-slash prefix,
 * so `BASE_PATH + "/app/1"` is always well-formed. Every link, form action and
 * redirect must go through `url()` in web/routes.ts rather than hardcoding a
 * path — a sub-path deployment breaks silently otherwise, with forms POSTing
 * to a 404 that looks like a permissions problem.
 */
export function normaliseBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export const BASE_PATH = normaliseBasePath(process.env.RW_BASE_PATH ?? "/analytics");

// Matched against the X-ExeDev-Email header the exe.dev proxy injects. That
// header is only trustworthy *behind* the proxy — reached directly it is
// whatever the client says it is. See DESIGN §5.1.
export const ADMIN_EMAILS: readonly string[] = (
  process.env.RW_ADMIN_EMAILS ?? "you@example.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

// --- Scheduling ------------------------------------------------------------
export const POLL_CRON = process.env.RW_POLL_CRON ?? "0 */6 * * *";
export const DIGEST_CRON = process.env.RW_DIGEST_CRON ?? "0 8 * * *";
export const TZ = process.env.RW_TZ ?? "Europe/London";

// --- Sources ---------------------------------------------------------------
// (not in DESIGN §7) Unauthenticated GitHub allows 60 req/hr; 38 feeds every 6 h
// sits well under it. If it ever bites, drop a fine-grained read-only PAT at
// this path and the poller picks it up — no code change.
export const GITHUB_TOKEN_FILE = expandHome(
  process.env.RW_GITHUB_TOKEN_FILE ?? "~/.config/relwatch/github-token",
);
export const GITHUB_PER_PAGE = intEnv(process.env.RW_GITHUB_PER_PAGE, 10, 1);
// (not in DESIGN §7) DESIGN §8.1 flags 5 as a guess; make it a knob so revising
// it is an env change rather than a redeploy of new code.
export const BACKFILL_DEPTH = intEnv(process.env.RW_BACKFILL_DEPTH, 5, 0);
export const SOURCE_TIMEOUT_MS = durationEnv(process.env.RW_SOURCE_TIMEOUT, 20_000);
export const USER_AGENT =
  process.env.RW_USER_AGENT ?? "relwatch/0.1 (+https://relwatch.example.com)";

// --- Digest / Hubbub -------------------------------------------------------
export const HUBBUB_BASE = process.env.RW_HUBBUB_BASE ?? "https://notify.example.com";
// (not in DESIGN §7) DESIGN §6.6 puts the key at this path, 0600. Read at call
// time rather than boot so a rotated key doesn't need a service restart.
export const HUBBUB_KEY_FILE = expandHome(
  process.env.RW_HUBBUB_KEY_FILE ?? "~/.config/relwatch/hubbub-key",
);
// Render guard under Hubbub's 128 KiB cap. Over this the renderer truncates with
// an explicit "N further releases not shown" footer — silent truncation is the
// failure mode this project exists to avoid.
export const MAX_HTML_BYTES = intEnv(process.env.RW_MAX_HTML_BYTES, 122_880, 1_024);
export const DRY_RUN = boolEnv(process.env.RW_DRY_RUN, false);

/** One-line startup banner; keeps the journal honest about what is actually set. */
export function describeConfig(): string {
  const model = BACKEND === "anthropic" ? ANTHROPIC_MODEL : OPENAI_MODEL;
  return [
    `backend=${BACKEND}`,
    `model=${model}`,
    `db=${DB_PATH}`,
    `port=${PORT}`,
    `tz=${TZ}`,
    `poll="${POLL_CRON}"`,
    `digest="${DIGEST_CRON}"`,
    DRY_RUN ? "dry-run=on" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
