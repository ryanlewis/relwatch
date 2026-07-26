// Digest rendering (DESIGN §5.2). Two parts from one release set:
//
//   html    — the newsletter, transmitted verbatim by Hubbub as the
//             multipart/alternative HTML part.
//   message — a *summary* (counts plus the major items) under 4 KiB, not a
//             parallel rendering of the same content.
//
// The renderer self-limits below Hubbub's 128 KiB cap and says so in the output
// when it does. Silent truncation is the failure mode this project exists to
// avoid, so a dropped release is always visible in the email itself.
import { MAX_HTML_BYTES } from "../config.js";
import type { ReleaseWithApp, Verdict } from "../db.js";
import { h, safeUrl } from "../web/html.js";

/** Rendered in this order; "untriaged" is a real group, never a silent drop. */
const GROUPS: { key: Verdict | "untriaged"; label: string }[] = [
  { key: "major", label: "Major" },
  { key: "interesting", label: "Interesting" },
  { key: "maintenance", label: "Maintenance" },
  { key: "untriaged", label: "Not triaged" },
];

export interface Digest {
  title: string;
  /** text/plain part — a summary, capped at 4 KiB. */
  message: string;
  /** text/html part — capped at RW_MAX_HTML_BYTES. */
  html: string;
  /** Ids covered by this digest — exactly what gets marked emailed on success. */
  ids: number[];
  /** How many releases were dropped by the byte cap, if any. */
  truncated: number;
}

type Grouped = Map<Verdict | "untriaged", ReleaseWithApp[]>;

function group(releases: readonly ReleaseWithApp[]): Grouped {
  const grouped: Grouped = new Map();
  for (const { key } of GROUPS) grouped.set(key, []);
  for (const release of releases) {
    grouped.get(release.verdict ?? "untriaged")?.push(release);
  }
  return grouped;
}

const MESSAGE_MAX_BYTES = 4_096;
const utf8 = new TextEncoder();

function byteLength(s: string): number {
  return utf8.encode(s).length;
}

/**
 * Truncate to a byte budget without splitting a multi-byte character.
 * Hubbub's caps are byte caps, and release titles routinely carry emoji.
 */
export function clampBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = s;
  while (out.length > 0 && byteLength(out) > max) {
    // Overshoot by the current excess in characters, which converges fast and
    // never lands mid-codepoint because slice() works on code units.
    const excess = byteLength(out) - max;
    out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil(excess / 2))));
  }
  return out;
}

export function renderDigest(
  releases: readonly ReleaseWithApp[],
  opts: { maxHtmlBytes?: number; now?: Date } = {},
): Digest {
  const maxBytes = opts.maxHtmlBytes ?? MAX_HTML_BYTES;
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);

  // Render in group order, adding releases until the budget is spent. The
  // ordering matters: if anything has to go, it should be maintenance, not a
  // major release.
  const ordered: ReleaseWithApp[] = [];
  const grouped = group(releases);
  for (const { key } of GROUPS) ordered.push(...(grouped.get(key) ?? []));

  let included = ordered;
  let truncated = 0;
  let html = buildHtml(included, date, 0);

  while (included.length > 0 && byteLength(html) > maxBytes) {
    // Drop from the end — the least important group — one at a time. Digests
    // are ~10-20 releases in normal operation, so this loop effectively never
    // runs; it exists so an anomalous day degrades visibly instead of failing.
    included = included.slice(0, -1);
    truncated = ordered.length - included.length;
    html = buildHtml(included, date, truncated);
  }

  const counts = countByGroup(ordered);
  const title = buildTitle(counts, ordered.length);

  return {
    title,
    message: clampBytes(buildMessage(ordered, counts, truncated), MESSAGE_MAX_BYTES),
    html,
    ids: included.map((r) => r.id),
    truncated,
  };
}

function countByGroup(releases: readonly ReleaseWithApp[]): Map<Verdict | "untriaged", number> {
  const counts = new Map<Verdict | "untriaged", number>();
  for (const { key } of GROUPS) counts.set(key, 0);
  for (const r of releases) {
    const key = r.verdict ?? "untriaged";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildTitle(counts: Map<Verdict | "untriaged", number>, total: number): string {
  const major = counts.get("major") ?? 0;
  const noun = total === 1 ? "release" : "releases";
  return major > 0 ? `${total} ${noun} (${major} major)` : `${total} ${noun}`;
}

/** The text/plain part: counts and the major items, not the whole digest again. */
function buildMessage(
  releases: readonly ReleaseWithApp[],
  counts: Map<Verdict | "untriaged", number>,
  truncated: number,
): string {
  const lines: string[] = [];
  const parts = GROUPS.filter(({ key }) => (counts.get(key) ?? 0) > 0).map(
    ({ key, label }) => `${counts.get(key)} ${label.toLowerCase()}`,
  );
  lines.push(`${releases.length} new release${releases.length === 1 ? "" : "s"}: ${parts.join(", ")}.`);

  const major = releases.filter((r) => r.verdict === "major");
  if (major.length > 0) {
    lines.push("", "Major:");
    for (const r of major) {
      lines.push(`- ${r.app_name} ${r.tag ?? ""}${r.breaking ? " [breaking]" : ""}`.trimEnd());
      if (r.summary) lines.push(`  ${r.summary}`);
    }
  }

  if (truncated > 0) {
    lines.push("", `${truncated} further release${truncated === 1 ? "" : "s"} not shown.`);
  }
  lines.push("", "Full archive: https://relwatch.example.com");
  return lines.join("\n");
}

function buildHtml(
  releases: readonly ReleaseWithApp[],
  date: string,
  truncated: number,
): string {
  const grouped = group(releases);

  const sections = GROUPS.filter(({ key }) => (grouped.get(key) ?? []).length > 0)
    .map(({ key, label }) => {
      const items = (grouped.get(key) ?? []).map(renderRelease).join("\n");
      return `
      <h2 style="font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;text-transform:uppercase;
                 letter-spacing:.06em;color:#6b6b64;margin:26px 0 10px;
                 border-bottom:1px solid #e3e3dd;padding-bottom:5px;">${h(label)}</h2>
      ${items}`;
    })
    .join("\n");

  // Truncation is stated in the body, not just implied by a short list.
  const footer =
    truncated > 0
      ? `<p style="font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#a11b2b;margin:22px 0 0;">
           ${truncated} further release${truncated === 1 ? "" : "s"} not shown — the digest hit its size limit.
           See the <a href="https://relwatch.example.com" style="color:#a11b2b;">dashboard</a> for the rest.
         </p>`
      : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>relwatch ${h(date)}</title></head>
<body style="margin:0;padding:22px 16px;background:#fbfbfa;">
<div style="max-width:640px;margin:0 auto;">
  <h1 style="font:600 19px/1.3 -apple-system,Segoe UI,sans-serif;color:#1a1a18;margin:0 0 4px;">
    Release digest
  </h1>
  <p style="font:13px/1.4 -apple-system,Segoe UI,sans-serif;color:#6b6b64;margin:0;">${h(date)}</p>
  ${sections}
  ${footer}
  <p style="font:12px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b6b64;margin:28px 0 0;
            border-top:1px solid #e3e3dd;padding-top:10px;">
    <a href="https://relwatch.example.com" style="color:#7a4b2a;">relwatch dashboard</a>
  </p>
</div>
</body></html>`;
}

function renderRelease(r: ReleaseWithApp): string {
  const link = safeUrl(r.url);
  const title = h(r.tag ?? r.title ?? "(untitled)");
  const titleHtml = link
    ? `<a href="${h(link)}" style="color:#7a4b2a;text-decoration:none;">${title}</a>`
    : title;

  const breaking = r.breaking
    ? `<span style="font:600 10px/1 -apple-system,Segoe UI,sans-serif;color:#a11b2b;
         background:#fdecee;padding:2px 5px;border-radius:3px;text-transform:uppercase;
         letter-spacing:.04em;">breaking</span>`
    : "";

  const summary = r.summary
    ? `<p style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1a1a18;margin:5px 0 0;">${h(r.summary)}</p>`
    : `<p style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b6b64;margin:5px 0 0;">Not triaged.</p>`;

  const highlights =
    r.highlights.length > 0
      ? `<ul style="font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#6b6b64;margin:6px 0 0;padding-left:18px;">
           ${r.highlights.map((item) => `<li>${h(item)}</li>`).join("")}
         </ul>`
      : "";

  return `
  <div style="background:#fff;border:1px solid #e3e3dd;border-radius:8px;padding:12px 14px;margin-bottom:9px;">
    <div style="font:14px/1.4 -apple-system,Segoe UI,sans-serif;">
      <strong style="color:#1a1a18;">${h(r.app_name)}</strong>
      <span style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#6b6b64;">${titleHtml}</span>
      ${breaking}
    </div>
    ${summary}
    ${highlights}
  </div>`;
}
