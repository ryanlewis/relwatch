// Dashboard views. The default is an inbox of undismissed releases; dismissed
// ones stay browsable through per-app history and the "all" filter, because
// dismissal hides and never deletes (DESIGN §5.1).
import type { App, ReleaseWithApp, Verdict } from "../db.js";
import { url } from "./auth.js";
import { h, html, layout, safeUrl, timeAgo, type SafeHtml } from "./html.js";

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
      ? html`<p class="empty">
          ${all ? "Nothing here yet." : "Inbox zero — nothing undismissed."}
        </p>`
      : releases.map((r) => releaseCard(r, isAdmin, view.now))}
    ${isAdmin && releases.length > 0 && !all
      ? html`<form class="inline" method="post" action="${url("/api/releases/dismiss-all")}">
          <button class="danger" type="submit">Dismiss all ${releases.length}</button>
        </form>`
      : ""}
    ${footer()}
  `;

  return layout({ title: "relwatch", body });
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
    <h2>
      ${app.name}${app.active ? "" : html` <span class="badge untriaged">removed</span>`}
    </h2>
    <p class="meta">
      ${app.kind} · <code>${app.ref}</code>${home ? html` · <a href="${home}">homepage</a>` : ""}
    </p>
    <p class="meta tally">
      ${releases.length} release${releases.length === 1 ? "" : "s"} ·
      <strong>${inbox.length}</strong> in inbox · ${dismissed} dismissed ·
      ${history} history
    </p>
    <nav class="filters">
      ${filterLink("Show all", appUrl, hideDismissed !== true)}
      ${filterLink("Inbox only", `${appUrl}?hide=1`, hideDismissed === true)}
      ${isAdmin && inbox.length > 0
        ? html`<form class="inline" method="post" action="${url(`/api/apps/${app.id}/dismiss-all`)}">
            <button class="danger" type="submit">Dismiss all ${inbox.length} in ${app.name}</button>
          </form>`
        : ""}
    </nav>
    ${shown.length === 0
      ? html`<p class="empty">
          ${releases.length === 0
            ? "No releases recorded yet."
            : "Nothing left in the inbox for this app."}
        </p>`
      : shown.map((r) => releaseCard(r, isAdmin, view.now, { showApp: false }))}
    ${history > 0
      ? html`<p class="legend">
          <strong>history</strong> — seen during the first poll of this app, so it is
          browsable but was never triaged and will never be emailed.
          <strong>dismissed</strong> — acknowledged; hidden from the inbox, never deleted.
        </p>`
      : ""}
    ${footer()}
  `;

  return layout({ title: `${app.name} — relwatch`, body });
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
    <h2>Roster</h2>
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
        <tr><th>Name</th><th>Kind</th><th>Reference</th><th>Releases</th>${isAdmin ? html`<th></th>` : ""}</tr>
      </thead>
      <tbody>
        ${apps.map(
          (app) => html`
            <tr>
              <td><a href="${url(`/app/${app.id}`)}">${app.name}</a></td>
              <td>${app.kind}</td>
              <td><code>${app.ref}</code></td>
              <td>${app.active ? "active" : "removed"}</td>
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
      <span class="meta">
        ${counts.inbox} in inbox · ${counts.apps} apps ·
        <a href="${url("/roster")}">roster</a>
        ${isAdmin ? "" : html` · <a href="/__exe.dev/login">sign in</a>`}
      </span>
    </header>
  `;
}

function filterLink(label: string, href: string, on: boolean): SafeHtml {
  return html`<a class="${on ? "on" : ""}" href="${href}">${label}</a>`;
}

function filters(verdict: Verdict | undefined, all: boolean): SafeHtml {
  const link = filterLink;
  const base = all ? `${url("/")}?all=1` : url("/");
  const withVerdict = (v: Verdict) => `${base}${all ? "&" : "?"}verdict=${v}`;

  return html`
    <nav class="filters">
      ${link("All verdicts", base, verdict === undefined)}
      ${VERDICTS.map((v) => link(v, withVerdict(v), verdict === v))}
      ${link(all ? "Hide dismissed" : "Show dismissed", all ? url("/") : `${url("/")}?all=1`, all)}
    </nav>
  `;
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
    <article class="release ${dismissed ? "dismissed" : ""}">
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
            <form class="inline" method="post" action="${url(`/api/releases/${r.id}/dismiss`)}">
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
