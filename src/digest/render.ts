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

// The digest carries the dashboard's visual system (src/web/html.ts): one mono
// face, square corners, dashed rules, uppercase tracked section labels, and a
// verdict-coloured left rail on each card.
//
// Two deliberate differences, both forced by email:
//
//   - It stays on paper. The dashboard's dark variant would be re-inverted by
//     Gmail's dark-mode filter and ignored outright by Outlook's Word engine,
//     which is how a "dark theme" email ends up as grey-on-grey.
//   - Labels are uppercased in the string rather than by `text-transform`,
//     which Outlook on Windows does not implement.
const C = {
  bg: "#fbfbfa",
  card: "#ffffff",
  fg: "#1a1a18",
  fg1: "#45453d",
  fg2: "#6b6b64",
  fg3: "#9c9c92",
  rule: "#d9d9d0",
  ruleStrong: "#b0b0a5",
  accent: "#7a4b2a",
  major: "#8f3a1f",
  interesting: "#2f5d3f",
  maintenance: "#6b6b64",
  breaking: "#a11b2b",
} as const;

// Short on purpose: this stack is repeated on every text element (mail clients
// cannot be trusted to inherit font-family), so each character is paid for once
// per release against Hubbub's byte cap.
const MONO = "Menlo,Consolas,monospace";

/** The rail colour is the verdict; breaking outranks it, as on the dashboard. */
function rail(r: ReleaseWithApp): string {
  if (r.breaking) return C.breaking;
  if (r.verdict === "major") return C.major;
  if (r.verdict === "interesting") return C.interesting;
  if (r.verdict === "maintenance") return C.maintenance;
  return C.fg3;
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
      const n = (grouped.get(key) ?? []).length;
      return `
      <h2 style="font:500 11px/1.4 ${MONO};letter-spacing:.08em;color:${C.fg2};margin:26px 0 10px;border-bottom:1px dashed ${C.rule};padding-bottom:6px;">${h(label.toUpperCase())} &middot; ${n}</h2>
      ${items}`;
    })
    .join("\n");

  // Truncation is stated in the body, not just implied by a short list.
  const footer =
    truncated > 0
      ? `<p style="font:13px/1.5 ${MONO};color:${C.breaking};margin:22px 0 0;
                   border-left:2px solid ${C.breaking};padding-left:10px;">
           ${truncated} further release${truncated === 1 ? "" : "s"} not shown — the digest hit its size limit.
           See the <a href="https://relwatch.example.com" style="color:${C.breaking};">dashboard</a> for the rest.
         </p>`
      : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>relwatch ${h(date)}</title></head>
<body style="margin:0;padding:24px 16px;background:${C.bg};">
<div style="max-width:640px;margin:0 auto;">
  <div style="border-bottom:1px solid ${C.ruleStrong};padding-bottom:8px;">
    <span style="font:700 15px/1.4 ${MONO};letter-spacing:.16em;color:${C.fg};">RELWATCH</span>
    <span style="font:400 11px/1.4 ${MONO};letter-spacing:.08em;color:${C.fg2};">&nbsp;&middot;&nbsp;${h(date)}</span>
  </div>
  ${sections}
  ${footer}
  <p style="font:400 11px/1.5 ${MONO};letter-spacing:.08em;color:${C.fg3};margin:30px 0 0;
            border-top:1px dashed ${C.rule};padding-top:10px;">
    <a href="https://relwatch.example.com" style="color:${C.fg3};">RELWATCH DASHBOARD</a>
  </p>
</div>
</body></html>`;
}

function renderRelease(r: ReleaseWithApp): string {
  const link = safeUrl(r.url);
  const title = h(r.tag ?? r.title ?? "(untitled)");
  const titleHtml = link
    ? `<a href="${h(link)}" style="color:${C.accent};text-decoration:none;">${title}</a>`
    : title;

  // The one loud element on a card: filled, where every other badge is a rule.
  const breaking = r.breaking
    ? `<span style="font:700 10px/1.6 ${MONO};color:${C.bg};background:${C.breaking};
         padding:1px 5px;letter-spacing:.1em;">BREAKING</span>`
    : "";

  const summary = r.summary
    ? `<p style="font:400 13px/1.55 ${MONO};color:${C.fg1};margin:6px 0 0;">${h(r.summary)}</p>`
    : `<p style="font:400 13px/1.55 ${MONO};color:${C.fg3};margin:6px 0 0;">Not triaged.</p>`;

  // list-style is dropped for a literal "·" — bullet rendering is one of the
  // least consistent things across mail clients.
  const highlights =
    r.highlights.length > 0
      ? `<ul style="font:400 12px/1.55 ${MONO};color:${C.fg2};margin:6px 0 0;padding:0;list-style:none;">
           ${r.highlights
             .map(
               (item) =>
                 `<li style="margin:1px 0;"><span style="color:${C.fg3};">&middot;</span> ${h(item)}</li>`,
             )
             .join("")}
         </ul>`
      : "";

  return `
  <div style="background:${C.card};border:1px solid ${C.rule};border-left:2px solid ${rail(r)};
              padding:11px 13px 12px;margin-bottom:7px;">
    <div style="font:400 13px/1.5 ${MONO};">
      <strong style="color:${C.fg};font-weight:700;">${h(r.app_name)}</strong>
      <span style="color:${C.fg2};">&nbsp;&nbsp;${titleHtml}</span>
      ${breaking}
    </div>
    ${summary}
    ${highlights}
  </div>`;
}
