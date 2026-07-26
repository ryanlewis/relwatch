// Dashboard views. The default is an inbox of undismissed releases; dismissed
// ones stay browsable through per-app history and the "all" filter, because
// dismissal hides and never deletes (DESIGN §5.1).
import type { App, ReleaseWithApp, Verdict } from "../db.js";
import { url } from "./auth.js";
import {
  dayKey,
  dayLabel,
  h,
  html,
  layout,
  safeUrl,
  timeAgo,
  type SafeHtml,
} from "./html.js";

const VERDICTS: Verdict[] = ["major", "interesting", "maintenance"];

export interface InboxView {
  releases: ReleaseWithApp[];
  apps: App[];
  isAdmin: boolean;
  /** Active verdict filter, if any. */
  verdict?: Verdict | undefined;
  /** Showing dismissed releases too. */
  all: boolean;
  counts: { apps: number; releases: number; inbox: number; pendingDigest: number };
  now?: number;
}

export function renderInbox(view: InboxView): string {
  const { releases, isAdmin, verdict, all } = view;

  const body = html`
    ${header(view.counts, isAdmin)}
    ${filters(verdict, all)}
    ${releases.length === 0
      ? empty(
          all ? "Nothing here yet" : "Inbox zero",
          all ? "No releases match this filter." : "Nothing undismissed.",
        )
      : byDay(releases).map(({ key, items }) =>
          daySection(key, items, isAdmin, view.now),
        )}
    ${isAdmin && releases.length > 0 && !all
      ? html`<form
          class="inline"
          method="post"
          action="${url("/api/releases/dismiss-all")}"
          data-dismiss-all="1"
        >
          <button class="danger" type="submit">
            Dismiss all <span data-dismiss-all-count>${releases.length}</span>
          </button>
        </form>`
      : ""}
    ${footer()}
  `;

  return layout({ title: "relwatch", body, showsDismissed: all });
}

export interface AppView {
  app: App;
  releases: ReleaseWithApp[];
  isAdmin: boolean;
  counts: InboxView["counts"];
  /** Hide dismissed releases on this page. */
  hideDismissed?: boolean;
  now?: number;
}

export function renderApp(view: AppView): string {
  const { app, releases, isAdmin, hideDismissed } = view;
  const home = safeUrl(app.homepage);

  // Two independent axes, which is why both get their own label on each card:
  // dismissed-or-not (is it still in the inbox) and backfilled-or-not (is it
  // history that will never be emailed).
  const inbox = releases.filter((r) => r.dismissed_at === null);
  const dismissed = releases.length - inbox.length;
  const history = releases.filter((r) => r.backfilled).length;
  const shown = hideDismissed ? inbox : releases;

  const appUrl = url(`/app/${app.id}`);

  const body = html`
    ${header(view.counts, isAdmin)}
    <h2 class="page">
      ${app.name}${app.active ? "" : html` <span class="badge untriaged">removed</span>`}
    </h2>
    <p class="meta">
      ${app.kind} · <code>${app.ref}</code>${home ? html` · <a href="${home}">homepage</a>` : ""}
    </p>
    <p class="label tally">
      ${releases.length} release${releases.length === 1 ? "" : "s"} ·
      <strong data-count="app-inbox">${inbox.length}</strong> in inbox ·
      <span data-count="app-dismissed">${dismissed}</span> dismissed ·
      ${history} history
    </p>
    <nav class="filters">
      <span class="chips">
        ${filterLink("Show all", appUrl, hideDismissed !== true)}
        ${filterLink("Inbox only", `${appUrl}?hide=1`, hideDismissed === true)}
      </span>
      ${isAdmin && inbox.length > 0
        ? html`<form
            class="inline"
            method="post"
            action="${url(`/api/apps/${app.id}/dismiss-all`)}"
            data-dismiss-all="1"
          >
            <button class="danger" type="submit">
              Dismiss all <span data-dismiss-all-count>${inbox.length}</span> in ${app.name}
            </button>
          </form>`
        : ""}
    </nav>
    ${shown.length === 0
      ? releases.length === 0
        ? empty("No releases", "Nothing recorded for this app yet.")
        : empty("Inbox zero", "Nothing left in the inbox for this app.")
      : byDay(shown).map(({ key, items }) =>
          daySection(key, items, isAdmin, view.now, { showApp: false }),
        )}
    ${history > 0
      ? html`<p class="legend">
          <strong>history</strong> — seen during the first poll of this app, so it is
          browsable but was never triaged and will never be emailed.
          <strong>dismissed</strong> — acknowledged; hidden from the inbox, never deleted.
        </p>`
      : ""}
    ${footer()}
  `;

  return layout({ title: `${app.name} — relwatch`, body, showsDismissed: !hideDismissed });
}

export interface RosterView {
  apps: App[];
  isAdmin: boolean;
  counts: InboxView["counts"];
}

export function renderRoster(view: RosterView): string {
  const { apps, isAdmin } = view;

  const body = html`
    ${header(view.counts, isAdmin)}
    <h2 class="section">Roster · ${apps.length} tracked</h2>
    ${isAdmin
      ? html`<form class="add" method="post" action="${url("/api/apps")}">
          <select name="kind">
            <option value="github">GitHub</option>
            <option value="rss">RSS / Atom</option>
          </select>
          <input name="ref" placeholder="owner/repo or feed URL" required />
          <input name="name" placeholder="display name (optional)" />
          <button type="submit">Add</button>
        </form>`
      : ""}
    <table class="roster">
      <thead>
        <tr><th>Name</th><th>Kind</th><th>Reference</th><th>State</th>${isAdmin ? html`<th></th>` : ""}</tr>
      </thead>
      <tbody>
        ${apps.map(
          (app) => html`
            <tr>
              <td><a href="${url(`/app/${app.id}`)}">${app.name}</a></td>
              <td class="off">${app.kind}</td>
              <td><code>${app.ref}</code></td>
              <td class="${app.active ? "" : "off"}">${app.active ? "active" : "removed"}</td>
              ${isAdmin
                ? html`<td>
                    ${app.active
                      ? html`<form class="inline" method="post" action="${url(`/api/apps/${app.id}/delete`)}">
                          <button class="danger" type="submit">Remove</button>
                        </form>`
                      : html`<form class="inline" method="post" action="${url("/api/apps")}">
                          <input type="hidden" name="kind" value="${app.kind}" />
                          <input type="hidden" name="ref" value="${app.ref}" />
                          <input type="hidden" name="name" value="${app.name}" />
                          <button type="submit">Restore</button>
                        </form>`}
                  </td>`
                : ""}
            </tr>
          `,
        )}
      </tbody>
    </table>
    ${footer()}
  `;

  return layout({ title: "Roster — relwatch", body });
}

// --- fragments -------------------------------------------------------------

function header(counts: InboxView["counts"], isAdmin: boolean): SafeHtml {
  return html`
    <header class="top">
      <h1><a href="${url("/")}">relwatch</a></h1>
      <span class="rule"></span>
      <span class="label">
        <span data-count="inbox">${counts.inbox}</span> unread · ${counts.apps} apps ·
        <a href="${url("/roster")}">roster</a>
        ${isAdmin ? "" : html` · <a href="/__exe.dev/login">sign in</a>`}
      </span>
    </header>
  `;
}

function filterLink(label: string, href: string, on: boolean): SafeHtml {
  return html`<a class="${on ? "on" : ""}" href="${href}">${label}</a>`;
}

/**
 * Two chip groups, not one. Verdict and dismissed-or-not are independent axes,
 * and running them together in a single strip reads as a single choice.
 */
function filters(verdict: Verdict | undefined, all: boolean): SafeHtml {
  const link = filterLink;
  const base = all ? `${url("/")}?all=1` : url("/");
  const withVerdict = (v: Verdict) => `${base}${all ? "&" : "?"}verdict=${v}`;
  const suffix = verdict === undefined ? "" : `verdict=${verdict}`;

  return html`
    <nav class="filters">
      <span class="chips">
        ${link("All", base, verdict === undefined)}
        ${VERDICTS.map((v) => link(v, withVerdict(v), verdict === v))}
      </span>
      <span class="chips">
        ${link("Inbox", suffix ? `${url("/")}?${suffix}` : url("/"), !all)}
        ${link("All time", `${url("/")}?all=1${suffix ? `&${suffix}` : ""}`, all)}
      </span>
    </nav>
  `;
}

/** Bucket a newest-first list into contiguous days, preserving that order. */
function byDay(releases: readonly ReleaseWithApp[]): { key: string; items: ReleaseWithApp[] }[] {
  const groups: { key: string; items: ReleaseWithApp[] }[] = [];
  for (const r of releases) {
    const key = dayKey(r.published_at, r.fetched_at);
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(r);
    else groups.push({ key, items: [r] });
  }
  return groups;
}

function daySection(
  key: string,
  items: readonly ReleaseWithApp[],
  isAdmin: boolean,
  now?: number,
  opts: { showApp?: boolean } = {},
): SafeHtml {
  return html`
    <section class="day">
      <h2>${dayLabel(key, now)}</h2>
      ${items.map((r) => releaseCard(r, isAdmin, now, opts))}
    </section>
  `;
}

function empty(headline: string, detail: string): SafeHtml {
  return html`<p class="empty"><b>${headline}</b><span>${detail}</span></p>`;
}

function releaseCard(
  r: ReleaseWithApp,
  isAdmin: boolean,
  now?: number,
  opts: { showApp?: boolean } = {},
): SafeHtml {
  const link = safeUrl(r.url);
  const title = r.tag ?? r.title ?? "(untitled)";
  const dismissed = r.dismissed_at !== null;

  return html`
    <article
      class="release ${dismissed ? "dismissed" : ""}"
      id="release-${r.id}"
      data-verdict="${r.verdict ?? ""}"
      data-breaking="${r.breaking ? "1" : ""}"
    >
      <div class="rhead">
        ${opts.showApp === false
          ? ""
          : html`<span class="app"><a href="${url(`/app/${r.app_id}`)}">${r.app_name}</a></span>`}
        <span class="tag">${link ? html`<a href="${link}">${title}</a>` : title}</span>
        ${verdictBadge(r)}
        ${r.breaking ? html`<span class="badge breaking">breaking</span>` : ""}
        ${r.backfilled ? html`<span class="badge history">history</span>` : ""}
        ${dismissed ? html`<span class="badge dismissed-tag">dismissed</span>` : ""}
        <span class="when">${timeAgo(r.published_at ?? r.fetched_at, now)}</span>
      </div>
      ${r.summary ? html`<p class="summary">${r.summary}</p>` : ""}
      ${r.highlights.length > 0
        ? html`<ul class="highlights">
            ${r.highlights.map((item) => html`<li>${item}</li>`)}
          </ul>`
        : ""}
      ${isAdmin && !dismissed
        ? html`<div class="actions">
            <form
              class="inline"
              method="post"
              action="${url(`/api/releases/${r.id}/dismiss`)}"
              data-dismiss="${r.id}"
            >
              <button type="submit">Dismiss</button>
            </form>
          </div>`
        : ""}
    </article>
  `;
}

/**
 * A release with no verdict is shown as "not triaged" rather than hidden — a
 * triage failure must never make a release disappear (DESIGN §4.3).
 */
function verdictBadge(r: ReleaseWithApp): SafeHtml {
  if (r.verdict === null) {
    // Backfilled history is deliberately untriaged, so it isn't a failure.
    return r.backfilled ? html`` : html`<span class="badge untriaged">not triaged</span>`;
  }
  return html`<span class="badge ${h(r.verdict)}">${r.verdict}</span>`;
}

function footer(): SafeHtml {
  return html`<footer class="foot">
    relwatch · polls every 6h · digest daily 08:00
  </footer>`;
}
