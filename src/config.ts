// Central configuration. Every tunable lives here, and every one is an RW_* env var
// so the systemd unit is the single place deployment differs from a local run.
//
// This file is the canonical list. README.md's configuration table is written by
// hand from it, so a knob added here needs a row added there.
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
// The defaults point at an OpenAI-compatible and an Anthropic-compatible gateway
// on the host network. Neither takes an API key, because the gateway authenticates
// the machine rather than the caller — which is why relwatch keeps no LLM
// credentials on disk. Point RW_OPENAI_BASE / RW_ANTHROPIC_BASE at any compatible
// endpoint; a real api.openai.com key would need a code change to pass through.
//
//   openai-responses — Responses API only: needs stream:true and store:false,
//                      and rejects max_output_tokens. That constraint is the
//                      reason the provider seam in triage/ exists.
//   anthropic        — plain Messages API, no such constraints.
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
 * Sub-path the dashboard is served under, for a deployment that mounts it behind
 * a reverse proxy at `/analytics` rather than on a bare domain.
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

export const BASE_PATH = normaliseBasePath(process.env.RW_BASE_PATH ?? "");

/**
 * Absolute URL of the dashboard, used only by the digest — an email has no origin
 * to resolve a relative link against, and the service cannot infer its own public
 * URL from behind a reverse proxy without trusting a forwarded header.
 *
 * Unset means the digest simply omits its dashboard links rather than emitting a
 * broken one.
 */
export const DASHBOARD_URL = (process.env.RW_DASHBOARD_URL ?? "").replace(/\/+$/, "");

// Matched against the X-ExeDev-Email header the exe.dev proxy injects. That
// header is only trustworthy *behind* a proxy that strips client-supplied copies
// of it — reached directly it is whatever the client says it is. See SECURITY.md.
//
// Empty by default: an unset RW_ADMIN_EMAILS means nobody is an admin, so a
// misconfigured deployment fails closed rather than handing the roster to the
// first identity the header happens to carry.
export const ADMIN_EMAILS: readonly string[] = (process.env.RW_ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

// --- Scheduling ------------------------------------------------------------
export const POLL_CRON = process.env.RW_POLL_CRON ?? "0 */6 * * *";
export const DIGEST_CRON = process.env.RW_DIGEST_CRON ?? "0 8 * * *";
export const TZ = process.env.RW_TZ ?? "Europe/London";

// --- Sources ---------------------------------------------------------------
// Unauthenticated GitHub allows 60 req/hr, which a few dozen feeds every 6 h sits
// well under. If it ever bites, drop a fine-grained read-only PAT at this path and
// the poller picks it up — no code change.
export const GITHUB_TOKEN_FILE = expandHome(
  process.env.RW_GITHUB_TOKEN_FILE ?? "~/.config/relwatch/github-token",
);
export const GITHUB_PER_PAGE = intEnv(process.env.RW_GITHUB_PER_PAGE, 10, 1);
// How deep the first poll of an app reaches. Five is a guess, so it is a knob:
// revising it is an env change rather than a redeploy.
export const BACKFILL_DEPTH = intEnv(process.env.RW_BACKFILL_DEPTH, 5, 0);
export const SOURCE_TIMEOUT_MS = durationEnv(process.env.RW_SOURCE_TIMEOUT, 20_000);
export const USER_AGENT =
  process.env.RW_USER_AGENT ?? "relwatch/0.1 (+https://github.com/ryanlewis/relwatch)";

// --- Digest / hubbub -------------------------------------------------------
// No default: the digest has nowhere to go until an operator names their hub, and
// a placeholder host would turn "unconfigured" into a connection error at 08:00
// rather than at startup.
export const HUBBUB_BASE = process.env.RW_HUBBUB_BASE ?? "";
// The hubbub API key, expected 0600. Read at call time rather than at boot, so a
// rotated key doesn't need a service restart.
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
