// Server-rendered HTML (DESIGN §3: one process, no framework, no build step).
//
// Everything rendered here originates upstream — release titles, notes, feed
// contents, and LLM output derived from all three. None of it is trusted, so
// `h` escapes and the `html` tag applies it to every interpolation by default.
// Deliberate raw insertion has to go through `raw()`, which makes it greppable.

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

const STYLES = `
:root {
  --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b64; --line: #e3e3dd;
  --card: #fff; --accent: #7a4b2a;
  --major: #8f3a1f; --major-bg: #fdefe9;
  --interesting: #2f5d3f; --interesting-bg: #ecf5ef;
  --maintenance: #4a4a54; --maintenance-bg: #f0f0f2;
  --breaking: #a11b2b; --breaking-bg: #fdecee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #e8e8e3; --muted: #9a9a92; --line: #2c2c32;
    --card: #1d1d22; --accent: #d0a077;
    --major: #f0a58a; --major-bg: #3a201a;
    --interesting: #9bd0ad; --interesting-bg: #1a2b20;
    --maintenance: #b6b6c0; --maintenance-bg: #26262c;
    --breaking: #f2929c; --breaking-bg: #3a1c21;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 1rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
a { color: var(--accent); }
header.top {
  display: flex; flex-wrap: wrap; gap: .75rem; align-items: baseline;
  justify-content: space-between; padding: 1.5rem 0 1rem;
  border-bottom: 1px solid var(--line); margin-bottom: 1.25rem;
}
header.top h1 { font-size: 1.25rem; margin: 0; letter-spacing: -0.01em; }
header.top h1 a { color: inherit; text-decoration: none; }
.meta { color: var(--muted); font-size: .85rem; }
nav.filters { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1.25rem; }
nav.filters a {
  padding: .2rem .6rem; border: 1px solid var(--line); border-radius: 999px;
  text-decoration: none; font-size: .82rem; color: var(--muted); background: var(--card);
}
nav.filters a.on { color: var(--fg); border-color: var(--accent); }
article.release {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .9rem 1rem; margin-bottom: .7rem;
}
article.release.dismissed { opacity: .55; }
/* The fetch path removes a card in place; this keeps that from being a jump cut.
   Height is animated too, so the cards below slide up rather than snap. */
article.release { transition: opacity .18s ease, transform .18s ease; }
article.release.leaving {
  opacity: 0; transform: translateX(-8px); pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  article.release { transition: none; }
  article.release.leaving { transform: none; }
}
button[data-busy] { opacity: .5; cursor: progress; }
.rhead { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.rhead .app { font-weight: 600; }
.rhead .tag { color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85rem; }
.rhead .when { margin-left: auto; color: var(--muted); font-size: .8rem; white-space: nowrap; }
.badge {
  font-size: .7rem; text-transform: uppercase; letter-spacing: .04em;
  padding: .1rem .45rem; border-radius: 4px; font-weight: 600;
}
.badge.major { color: var(--major); background: var(--major-bg); }
.badge.interesting { color: var(--interesting); background: var(--interesting-bg); }
.badge.maintenance { color: var(--maintenance); background: var(--maintenance-bg); }
.badge.breaking { color: var(--breaking); background: var(--breaking-bg); }
.badge.untriaged { color: var(--muted); background: transparent; border: 1px dashed var(--line); }
/* State badges. Deliberately quieter than the verdict badges: they describe
   where a release sits, not how important it is. */
.badge.history { color: var(--muted); background: transparent; border: 1px solid var(--line); }
.badge.dismissed-tag { color: var(--muted); background: var(--maintenance-bg); }
.tally strong { color: var(--fg); }
.legend {
  margin-top: 1.5rem; padding-top: .75rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: .82rem; line-height: 1.5;
}
.legend strong { color: var(--fg); font-weight: 600; }
.summary { margin: .45rem 0 0; }
ul.highlights { margin: .45rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: .9rem; }
.actions { display: flex; gap: .5rem; align-items: center; margin-top: .6rem; }
form.inline { display: inline; }
button {
  font: inherit; font-size: .82rem; padding: .18rem .6rem; cursor: pointer;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--muted);
}
button:hover { color: var(--fg); border-color: var(--accent); }
button.danger:hover { color: var(--breaking); border-color: var(--breaking); }
.empty { color: var(--muted); padding: 2.5rem 0; text-align: center; }
table.roster { width: 100%; border-collapse: collapse; font-size: .9rem; }
table.roster th { text-align: left; color: var(--muted); font-weight: 500; }
table.roster th, table.roster td { padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
form.add { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
form.add input, form.add select {
  font: inherit; font-size: .85rem; padding: .3rem .5rem;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg);
}
form.add input[name="ref"] { flex: 1 1 18rem; }
footer.foot { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
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
        card.remove();
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
