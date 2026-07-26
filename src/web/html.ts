// Server-rendered HTML (DESIGN §3: one process, no framework, no build step).
//
// Everything rendered here originates upstream — release titles, notes, feed
// contents, and LLM output derived from all three. None of it is trusted, so
// `h` escapes and the `html` tag applies it to every interpolation by default.
// Deliberate raw insertion has to go through `raw()`, which makes it greppable.
import { TZ } from "../config.js";

/**
 * Escape for HTML text and double-quoted attribute contexts.
 *
 * The parameter is deliberately not `unknown`: passing an object here is always
 * a mistake (it would render as "[object Object]"), and the type is what stops
 * that reaching a page.
 */
export function h(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Marks a string as already-safe, so `html` won't escape it again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/**
 * Template tag that escapes every interpolation unless it is SafeHtml.
 * Arrays are joined, so `${rows.map(row)}` composes without a manual join.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (const [i, value] of values.entries()) {
    out += render(value) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  // null/undefined/false render as nothing, so `cond && html`…`` composes.
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return h(value);
  }
  // An object reaching a template is a bug, not a rendering decision. Escaping
  // its JSON keeps the page safe and makes the mistake obvious on screen.
  return h(JSON.stringify(value));
}

/**
 * Only allow URLs we're willing to put in an href.
 *
 * Release payloads are upstream data: a `javascript:` link in a feed would
 * otherwise become a working XSS vector on the dashboard.
 */
export function safeUrl(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Relative links are ours, so they're fine; anything else (javascript:,
  // data:, vbscript:) is dropped rather than sanitised.
  if (trimmed.startsWith("/")) return trimmed;
  return null;
}

/**
 * Visual system, adapted from shout.sh (`~/dev/shout-sh/web/src/styles.css`).
 *
 * What is borrowed: one monospace face for everything, square corners, dashed
 * rules as the separator of record, uppercase micro-labels at 11px/.08em, chip
 * groups that invert when active, and `[ bracket ]` buttons that invert on
 * hover. What is not: shout's pure-black ground. relwatch keeps its warm paper
 * and rust accent, so the grammar is shared but the surface is its own.
 *
 * The mono stack is the system one rather than shout's Google-hosted JetBrains
 * Mono — a webfont would put a network dependency in front of first paint on a
 * dashboard that is otherwise one self-contained binary.
 */
const STYLES = `
:root {
  --bg: #fbfbfa; --bg-1: #f2f1ec; --card: #fff;
  --fg: #1a1a18; --fg-1: #45453d; --fg-2: #6b6b64; --fg-3: #9c9c92;
  --rule: #d9d9d0; --rule-strong: #b0b0a5;
  --accent: #7a4b2a;
  --major: #8f3a1f; --interesting: #2f5d3f; --maintenance: #6b6b64;
  --breaking: #a11b2b;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
          "DejaVu Sans Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312; --bg-1: #1f1f1c; --card: #1a1a18;
    --fg: #ebebe3; --fg-1: #c2c2b8; --fg-2: #8e8e85; --fg-3: #62625b;
    --rule: #302f2b; --rule-strong: #55554d;
    --accent: #d0a077;
    --major: #f0a58a; --interesting: #9bd0ad; --maintenance: #8e8e85;
    --breaking: #f2929c;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; padding: 0 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font-family: var(--mono); font-size: 14px; line-height: 1.55;
  font-variant-ligatures: none; -webkit-font-smoothing: antialiased;
}
main { max-width: 54rem; margin: 0 auto; }
a { color: var(--accent); text-underline-offset: 2px; }
code { font-family: inherit; background: var(--bg-1); padding: .05rem .3rem; color: var(--fg-1); }
::selection { background: var(--fg); color: var(--bg); }
:focus-visible { outline: 1px dashed var(--fg); outline-offset: 2px; }

/* Micro-label: the uppercase 11px/.08em run that carries every piece of
   secondary chrome — counts, column heads, day markers, the footer. */
.label {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--fg-2);
}
.label a { color: var(--fg-2); text-decoration: none; border-bottom: 1px dashed var(--rule-strong); }
.label a:hover { color: var(--fg); border-bottom-color: var(--fg); }
.label [data-count], .label strong { color: var(--fg); font-weight: 700; }
.meta { color: var(--fg-2); font-size: 12px; }

/* Masthead: wordmark, a rule that eats the slack, then the tallies. */
header.top {
  display: flex; flex-wrap: wrap; align-items: center; gap: .85rem;
  padding: 1.75rem 0 0; margin-bottom: 1.5rem;
}
header.top h1 {
  margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .16em;
  text-transform: uppercase;
}
header.top h1 a { color: var(--fg); text-decoration: none; }
header.top h1 a:hover { color: var(--accent); }
.rule { flex: 1 1 3rem; border-top: 1px dashed var(--rule); height: 0; }

h2.page { font-size: 17px; font-weight: 700; letter-spacing: .02em; margin: 0 0 .35rem; }
h2.section {
  font-size: 11px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
  color: var(--fg-2); border-bottom: 1px dashed var(--rule);
  padding-bottom: .4rem; margin: 0 0 1rem;
}

/* Chip group: one outer border with dividers between, active chip inverted. */
nav.filters {
  display: flex; flex-wrap: wrap; align-items: center; gap: .75rem;
  margin: 1.25rem 0;
}
.chips { display: flex; border: 1px solid var(--rule-strong); }
.chips a {
  padding: .3rem .7rem; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--fg-2); text-decoration: none;
  white-space: nowrap; border-right: 1px solid var(--rule-strong);
}
.chips a:last-child { border-right: 0; }
.chips a:hover { color: var(--fg); background: var(--bg-1); }
.chips a.on { background: var(--fg); color: var(--bg); }
.chips a:focus-visible { outline-offset: -3px; }

/* Day marker. Releases arrive in a stream; this is what gives it structure. */
section.day > h2 {
  display: flex; align-items: center; gap: .7rem;
  margin: 1.6rem 0 .7rem; font-size: 11px; font-weight: 500;
  letter-spacing: .08em; text-transform: uppercase; color: var(--fg-2);
}
section.day > h2::before { content: "\\2500\\2500"; color: var(--fg-3); letter-spacing: 0; }
section.day > h2::after { content: ""; flex: 1; border-top: 1px dashed var(--rule); }
section.day:first-of-type > h2 { margin-top: .5rem; }

/* The left rail is the verdict, readable in peripheral vision down the page. */
article.release {
  background: var(--card); border: 1px solid var(--rule);
  border-left: 2px solid var(--fg-3);
  padding: .7rem .9rem .75rem; margin-bottom: .5rem;
  transition: opacity .18s ease, transform .18s ease;
}
article.release[data-verdict="major"] { border-left-color: var(--major); }
article.release[data-verdict="interesting"] { border-left-color: var(--interesting); }
article.release[data-verdict="maintenance"] { border-left-color: var(--maintenance); }
/* Breaking outranks the verdict: whatever else it is, that is the rail to see. */
article.release[data-breaking="1"] { border-left-color: var(--breaking); }
article.release.dismissed { opacity: .5; border-left-color: var(--rule-strong); }
/* The fetch path removes a card in place; this keeps that from being a jump cut. */
article.release.leaving { opacity: 0; transform: translateX(-8px); pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  article.release { transition: none; }
  article.release.leaving { transform: none; }
}

.rhead { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.rhead .app a { color: var(--fg); font-weight: 700; text-decoration: none; }
.rhead .app a:hover { color: var(--accent); }
.rhead .tag { color: var(--fg-2); }
.rhead .tag a { color: var(--accent); text-decoration: none; }
.rhead .tag a:hover { text-decoration: underline; }
.rhead .when {
  margin-left: auto; color: var(--fg-3); font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; white-space: nowrap;
}
.summary { margin: .5rem 0 0; color: var(--fg-1); max-width: 74ch; }
ul.highlights {
  margin: .45rem 0 0; padding: 0; list-style: none;
  color: var(--fg-2); font-size: 13px; max-width: 74ch;
}
ul.highlights li { position: relative; padding-left: 1.1rem; }
ul.highlights li::before { content: "\\00b7"; position: absolute; left: .35rem; color: var(--fg-3); }

/* Outline badges throughout, so that exactly one thing on a card is loud. */
.badge {
  font-size: 10px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase;
  padding: .1rem .4rem; border: 1px solid currentColor; line-height: 1.5;
  white-space: nowrap;
}
.badge.major { color: var(--major); }
.badge.interesting { color: var(--interesting); }
.badge.maintenance { color: var(--maintenance); }
.badge.breaking {
  color: var(--bg); background: var(--breaking); border-color: var(--breaking);
  font-weight: 700;
}
.badge.untriaged { color: var(--fg-3); border-style: dashed; }
/* State badges: where a release sits, not how important it is. */
.badge.history { color: var(--fg-3); border-style: dashed; }
.badge.dismissed-tag { color: var(--fg-3); }

/* Buttons wear their brackets in CSS — decorative, so they stay out of the
   accessible name. Hover inverts, which is shout.sh's whole button language. */
.actions { display: flex; gap: .5rem; align-items: center; margin: .5rem 0 0 -.5rem; }
form.inline { display: inline; }
button {
  font: inherit; font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
  padding: .15rem .5rem; cursor: pointer; border: 0; background: transparent;
  color: var(--fg-2);
}
button::before { content: "["; color: var(--fg-3); margin-right: .35rem; }
button::after { content: "]"; color: var(--fg-3); margin-left: .35rem; }
button:hover, button:hover::before, button:hover::after { color: var(--bg); }
button:hover { background: var(--fg); }
button.danger:hover { background: var(--breaking); }
button:focus-visible { outline-offset: -1px; }
button[data-busy] { opacity: .5; cursor: progress; }

.empty {
  border: 1px dashed var(--rule); padding: 2.75rem 1rem; margin: .5rem 0;
  text-align: center;
}
.empty b {
  display: block; color: var(--fg); font-weight: 700; font-size: 12px;
  letter-spacing: .16em; text-transform: uppercase;
}
.empty span { display: block; margin-top: .4rem; color: var(--fg-2); font-size: 12px; }

.legend {
  margin-top: 1.75rem; padding-top: .8rem; border-top: 1px dashed var(--rule);
  color: var(--fg-2); font-size: 12px; max-width: 74ch;
}
.legend strong { color: var(--fg); font-weight: 700; }

table.roster { width: 100%; border-collapse: collapse; font-size: 13px; }
table.roster th {
  text-align: left; font-size: 11px; font-weight: 500; letter-spacing: .08em;
  text-transform: uppercase; color: var(--fg-2);
  border-bottom: 1px solid var(--rule-strong);
}
table.roster th, table.roster td { padding: .45rem .6rem; }
table.roster td { border-bottom: 1px dashed var(--rule); }
table.roster tbody tr:hover td { background: var(--bg-1); }
table.roster th:first-child, table.roster td:first-child { padding-left: 0; }
table.roster th:last-child, table.roster td:last-child { padding-right: 0; text-align: right; }
table.roster td a { color: var(--fg); text-decoration: none; font-weight: 700; }
table.roster td a:hover { color: var(--accent); }
table.roster .off { color: var(--fg-3); }

form.add { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 0 0 1.5rem; }
form.add input, form.add select {
  font: inherit; font-size: 13px; padding: .3rem .5rem; border-radius: 0;
  border: 1px solid var(--rule-strong); background: var(--bg-1); color: var(--fg);
}
form.add input::placeholder { color: var(--fg-3); }
form.add input:focus-visible, form.add select:focus-visible { outline-offset: -3px; }
form.add input[name="ref"] { flex: 1 1 20rem; }

footer.foot {
  margin-top: 3rem; border-top: 1px dashed var(--rule); padding-top: .9rem;
  color: var(--fg-3); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
}

/* A wrapped chip row strands rows without top/bottom borders, so below this
   width each chip carries its own box instead (shout.sh solves it the same way).
   Form controls go to 16px to block iOS focus-zoom. */
@media (max-width: 640px) {
  body { padding: 0 .85rem 3rem; }
  .chips { flex-wrap: wrap; gap: 5px; border: 0; }
  .chips a { border: 1px solid var(--rule-strong); padding: .35rem .6rem; }
  .chips a:last-child { border-right: 1px solid var(--rule-strong); }
  header.top .rule { display: none; }
  form.add input, form.add select { font-size: 16px; flex: 1 1 100%; }
  .rhead .when { margin-left: 0; }
}
`;

/**
 * Progressive enhancement for dismissals.
 *
 * The forms below are real forms and work with this script absent or broken —
 * that is deliberate, and it is why the server still answers a plain POST with
 * a 303. What this adds is the interactive path: a fetch, an in-place update,
 * and no navigation, so a dismissal doesn't cost a full page render or leave a
 * redirect sitting in the history stack for Back to land on.
 *
 * Inline and dependency-free, because "no SPA, no build step" (DESIGN §3) is a
 * property worth keeping.
 */
const SCRIPT = `
(function () {
  var main = document.querySelector("main");
  if (!main || !window.fetch) return;
  var showsDismissed = main.dataset.showsDismissed === "1";

  function setCount(name, value) {
    document.querySelectorAll('[data-count="' + name + '"]').forEach(function (el) {
      el.textContent = String(value);
    });
  }

  function markDismissed(card) {
    if (!card || card.classList.contains("dismissed")) return;
    card.classList.add("dismissed");
    var actions = card.querySelector(".actions");
    if (actions) actions.remove();
    if (showsDismissed) {
      var when = card.querySelector(".when");
      var badge = document.createElement("span");
      badge.className = "badge dismissed-tag";
      badge.textContent = "dismissed";
      if (when) when.parentNode.insertBefore(badge, when);
    } else {
      // Animate out, then remove. The empty state has to appear once the last
      // card goes, or the page just looks broken.
      card.classList.add("leaving");
      window.setTimeout(function () {
        var day = card.closest("section.day");
        card.remove();
        // A day marker with nothing under it is worse than no marker at all.
        if (day && !day.querySelector("article.release")) day.remove();
        if (!document.querySelector("article.release")) window.location.reload();
      }, 180);
    }
  }

  function applyCounts(data) {
    if (data.counts) setCount("inbox", data.counts.inbox);
    if (data.app) {
      setCount("app-inbox", data.app.inbox);
      setCount("app-dismissed", data.app.dismissed);
    }
    document.querySelectorAll("[data-dismiss-all-count]").forEach(function (el) {
      var n = data.app ? data.app.inbox : data.counts ? data.counts.inbox : 0;
      var form = el.closest("form");
      if (n > 0) { el.textContent = String(n); } else if (form) { form.remove(); }
    });
  }

  main.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    var single = form.dataset.dismiss;
    var all = form.dataset.dismissAll;
    if (single === undefined && all === undefined) return;

    ev.preventDefault();
    var button = form.querySelector("button");
    if (button) { button.disabled = true; button.dataset.busy = "1"; }

    fetch(form.action, {
      method: "POST",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) throw new Error("status " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (single !== undefined) {
          markDismissed(document.getElementById("release-" + single));
        } else {
          main.querySelectorAll("article.release:not(.dismissed)").forEach(markDismissed);
        }
        applyCounts(data);
      })
      .catch(function () {
        // Anything unexpected — a 403 after a session expired, a network drop —
        // hands back to the plain form submit rather than silently doing nothing.
        if (button) { button.disabled = false; delete button.dataset.busy; }
        form.submit();
      });
  });
})();
`;

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** True on views that keep dismissed releases on screen (per-app history). */
  showsDismissed?: boolean;
}

export function layout({ title, body, showsDismissed }: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)}</title>
<style>${STYLES}</style>
</head>
<body><main data-shows-dismissed="${showsDismissed ? "1" : "0"}">${body.value}</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

// Day bucketing for the release stream. The service already has one timezone
// (config's TZ, what the digest cron runs on), so "today" means today there —
// not in UTC, which would roll the marker over at the wrong hour for eight
// months of the year.
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` in the service timezone — the grouping key, and its own label. */
export function dayKey(iso: string | null, fallback: string): string {
  const ms = Date.parse(iso ?? fallback);
  return Number.isNaN(ms) ? "" : dayFormat.format(new Date(ms));
}

/** "today" / "yesterday" while that's still the useful frame, ISO after. */
export function dayLabel(key: string, now = Date.now()): string {
  if (key === "") return "undated";
  if (key === dayFormat.format(new Date(now))) return "today";
  if (key === dayFormat.format(new Date(now - 86_400_000))) return "yesterday";
  return key;
}

/** "3 hours ago" — relative where it helps, absolute once it doesn't. */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
