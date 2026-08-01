// Machine-readable renderings of the three read views.
//
// The dashboard is for a person and the digest is for an inbox; this is for a
// reader that wants the data rather than the page — an agent session, a script,
// a curl. It renders the *same* view objects `views.ts` does, so a filter that
// changes what the HTML shows changes these with it and the three renderings
// cannot drift into disagreeing about what the inbox is.
//
// Markdown has no escaping story the way HTML does, and everything here still
// originates upstream, so `inline` below does the job the `html` tag does
// there: it is applied to every interpolated value, without exception.
import { inInbox, type App, type ReleaseWithApp } from "../db.js";
import { url } from "./auth.js";
import { byDay, type AppView, type InboxView, type RosterView } from "./views.js";
import { dayLabel, safeUrl, timeAgo } from "./html.js";

export type Format = "html" | "json" | "md";

/**
 * `?format=` beats `Accept:`, so a link is enough to reach the machine
 * renderings and nothing has to be able to set a header.
 *
 * An unrecognised value falls back to HTML rather than erroring, the same way
 * a bogus `?verdict=` falls back to no filter: a typo in a query string should
 * still show you the page.
 */
export function negotiate(params: URLSearchParams, req: Request): Format {
  const requested = params.get("format")?.trim().toLowerCase() ?? "";
  if (requested === "json") return "json";
  if (requested === "md" || requested === "markdown") return "md";
  if (requested !== "") return "html";

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/markdown")) return "md";
  return "html";
}

// --- JSON ------------------------------------------------------------------

/**
 * One release, flattened.
 *
 * `notes` is deliberately absent. It is the raw upstream body — the *input* to
 * triage, routinely tens of kilobytes, and three hundred of them would make
 * the inbox a payload nobody wants to read. What triage made of it is here in
 * `summary` and `highlights`, and `url` is where the original lives.
 */
function releaseJson(r: ReleaseWithApp): Record<string, unknown> {
  return {
    id: r.id,
    app: { id: r.app_id, name: r.app_name, kind: r.app_kind, ref: r.app_ref },
    tag: r.tag,
    title: r.title,
    // Same filter the pages apply: a `javascript:` href from a feed is dropped
    // rather than handed on to whatever renders this next.
    url: safeUrl(r.url),
    verdict: r.verdict,
    summary: r.summary,
    breaking: r.breaking,
    highlights: r.highlights,
    published_at: r.published_at,
    fetched_at: r.fetched_at,
    // The three states, named rather than left to be re-derived from the
    // timestamps below. `in_inbox` is the store's own definition, not a
    // fourth restatement of it.
    in_inbox: inInbox(r),
    backfilled: r.backfilled,
    dismissed_at: r.dismissed_at,
    emailed_at: r.emailed_at,
    triaged_at: r.triaged_at,
    triage_error: r.triage_error,
  };
}

function appJsonRow(app: App): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    kind: app.kind,
    ref: app.ref,
    homepage: safeUrl(app.homepage),
    active: app.active,
    added_at: app.added_at,
    seeded_at: app.seeded_at,
  };
}

/**
 * Whether the list ran into its cap. The exact overflow isn't known without a
 * second count, so this says "there may be more" rather than inventing a
 * number — but it does say it, because a caller seeing exactly `limit` rows
 * has no other way to tell a full page from a complete answer.
 */
function limitReached(count: number, limit: number | undefined): boolean {
  return limit !== undefined && count >= limit;
}

export function inboxJson(view: InboxView): Record<string, unknown> {
  return {
    view: "inbox",
    counts: view.counts,
    filter: {
      verdict: view.verdict ?? null,
      app: view.appId ?? null,
      all: view.all,
    },
    limit: view.limit ?? null,
    limit_reached: limitReached(view.releases.length, view.limit),
    releases: view.releases.map(releaseJson),
  };
}

export function appJson(view: AppView): Record<string, unknown> {
  const { app, releases } = view;
  const shown = view.hideDismissed === true ? releases.filter(inInbox) : releases;
  return {
    view: "app",
    app: appJsonRow(app),
    // Counted across everything, not across `shown` — the tallies describe the
    // app, and `?hide=1` only decides what is listed.
    tallies: {
      total: releases.length,
      inbox: releases.filter(inInbox).length,
      dismissed: releases.filter((r) => r.dismissed_at !== null).length,
      history: releases.filter((r) => r.backfilled).length,
    },
    counts: view.counts,
    hide_dismissed: view.hideDismissed === true,
    limit: view.limit ?? null,
    limit_reached: limitReached(releases.length, view.limit),
    releases: shown.map(releaseJson),
  };
}

export function rosterJson(view: RosterView): Record<string, unknown> {
  return {
    view: "roster",
    counts: view.counts,
    apps: view.apps.map(appJsonRow),
  };
}

// --- Markdown --------------------------------------------------------------

// The characters that change inline rendering. Escaped everywhere rather than
// per-context, so no caller has to remember which context it is in — `\|` is
// harmless outside a table, and all of these are escapable in CommonMark.
const INLINE_SPECIALS = /[\\`*_[\]|]/g;

/**
 * Flatten and escape one upstream value for use *within* a line.
 *
 * The dangerous character in markdown is the newline: a release title carrying
 * one plus a `## ` opens a section a reader — human or model — cannot tell from
 * one we wrote. So whitespace collapses first, then the characters that change
 * inline rendering are escaped.
 */
export function inline(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(INLINE_SPECIALS, (c) => `\\${c}`);
}

/**
 * As `inline`, for a value that begins a line or a list item and could
 * therefore open a block of its own.
 *
 * Kept separate because the escape is wrong anywhere else: nearly every tag
 * starts with a digit, and `### uv — \0.12.1` is both ugly and broken — a
 * backslash only escapes ASCII punctuation, so `\0` renders literally and the
 * version number arrives corrupted. Only the summary and the highlights need
 * it; headings and table cells already have something in front of them.
 */
export function lineStart(value: string | number | null | undefined): string {
  return inline(value).replace(/^([#>+-]|\d+[.)])/, "\\$1");
}

/** Blank-line-separated blocks. Empty ones drop out, so no stray double rules. */
function blocks(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n");
}

/**
 * Badges mirror the dashboard card's, in its order. Every one of them is a
 * fixed word from a closed set, which is why they can sit in code spans.
 */
function badges(r: ReleaseWithApp): string {
  const labels = [
    r.verdict ?? (r.backfilled ? null : "not triaged"),
    r.breaking === true ? "breaking" : null,
    r.backfilled ? "history" : null,
    r.dismissed_at === null ? null : "dismissed",
  ].filter((b): b is string => b !== null);
  return labels.map((b) => `\`${b}\``).join(" ");
}

function releaseMarkdown(
  r: ReleaseWithApp,
  now: number | undefined,
  opts: { showApp?: boolean } = {},
): string {
  const title = inline(r.tag ?? r.title ?? "(untitled)");
  const name = opts.showApp === false ? title : `${inline(r.app_name)} — ${title}`;
  const badge = badges(r);

  const link = safeUrl(r.url);
  const meta = [`id ${r.id}`, timeAgo(r.published_at ?? r.fetched_at, now), link]
    .filter((p) => p !== null && p !== "")
    .join(" · ");

  return blocks(
    `### ${name}${badge === "" ? "" : ` ${badge}`}`,
    // A triage failure renders as untriaged; it never removes the release.
    // Summary and highlights both begin a line, hence lineStart.
    r.summary === null ? "_Not triaged._" : lineStart(r.summary),
    r.highlights.map((item) => `- ${lineStart(item)}`).join("\n"),
    meta,
  );
}

function days(releases: readonly ReleaseWithApp[], now: number | undefined, showApp: boolean): string {
  return byDay(releases)
    .map(({ key, items }) =>
      blocks(
        `## ${inline(dayLabel(key, now))}`,
        ...items.map((r) => releaseMarkdown(r, now, { showApp })),
      ),
    )
    .join("\n\n");
}

/** So a session that has just read a list knows how to act on one. */
function dismissHint(): string {
  return `---\n\nDismiss: \`POST ${url("/api/releases/<id>/dismiss")}\` — admin only, see README.`;
}

export function inboxMarkdown(view: InboxView): string {
  const { counts, releases } = view;

  const applied = [
    view.verdict === undefined ? null : `verdict=${view.verdict}`,
    view.appId === undefined ? null : `app=${view.appId}`,
    view.all ? "all=1" : null,
  ].filter((f): f is string => f !== null);

  return `${blocks(
    "# relwatch — inbox",
    `${counts.inbox} unread · ${counts.apps} apps · ${counts.releases} releases · ${counts.pendingDigest} pending digest`,
    applied.length === 0 ? null : `Filter: ${applied.join(" · ")}`,
    releases.length === 0
      ? view.all
        ? "No releases match this filter."
        : "Inbox zero — no news waiting."
      : days(releases, view.now, true),
    // Stated, never implied by a short list.
    limitReached(releases.length, view.limit)
      ? `**${view.limit} shown, and the list limit was reached — there may be more.** Narrow with \`?app=\` or \`?verdict=\`.`
      : null,
    dismissHint(),
  )}\n`;
}

export function appMarkdown(view: AppView): string {
  const { app, releases } = view;
  const shown = view.hideDismissed === true ? releases.filter(inInbox) : releases;
  const inbox = releases.filter(inInbox).length;
  const dismissed = releases.filter((r) => r.dismissed_at !== null).length;
  const history = releases.filter((r) => r.backfilled).length;
  const home = safeUrl(app.homepage);

  return `${blocks(
    `# ${inline(app.name)}${app.active ? "" : " (removed)"}`,
    [`${inline(app.kind)} · ${inline(app.ref)}`, home].filter((p) => p !== null).join(" · "),
    `${releases.length} release${releases.length === 1 ? "" : "s"} · ${inbox} in inbox · ${dismissed} dismissed · ${history} history`,
    shown.length === 0
      ? releases.length === 0
        ? "Nothing recorded for this app yet."
        : "Nothing left in the inbox for this app."
      : days(shown, view.now, false),
    history === 0
      ? null
      : "`history` — published before this app was seeded, so it stays out of the inbox, was never triaged and will never be emailed. `dismissed` — acknowledged; hidden from the inbox, never deleted.",
    limitReached(releases.length, view.limit)
      ? `**${view.limit} shown, and the history limit was reached — there may be more.**`
      : null,
    dismissHint(),
  )}\n`;
}

export function rosterMarkdown(view: RosterView): string {
  const { apps, counts } = view;
  const rows = apps.map(
    (a) =>
      `| ${a.id} | ${inline(a.name)} | ${inline(a.kind)} | ${inline(a.ref)} | ${a.active ? "active" : "removed"} |`,
  );

  return `${blocks(
    "# relwatch — roster",
    `${apps.length} listed · ${counts.apps} active · ${counts.inbox} unread`,
    apps.length === 0
      ? "Nothing on the roster yet."
      : ["| Id | Name | Kind | Reference | State |", "|---|---|---|---|---|", ...rows].join("\n"),
  )}\n`;
}
