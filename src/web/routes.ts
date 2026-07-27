// Route table (DESIGN §5.1). Public read; every mutation gated by requireAdmin.
//
// Mutations are plain form POSTs rather than fetch() calls, so the dashboard
// needs no client JavaScript and no build step. That includes app removal:
// HTML forms can't issue DELETE, so it is POST /api/apps/:id/delete.
import type { AppKind, Store, Verdict } from "../db.js";
import { BASE_PATH } from "../config.js";
import { deriveAppName } from "../source/index.js";
import { identify, requireAdmin, url } from "./auth.js";
import { renderApp, renderInbox, renderRoster } from "./views.js";

const VERDICTS: readonly Verdict[] = ["major", "interesting", "maintenance"];

function isVerdict(value: string | null): value is Verdict {
  return value !== null && VERDICTS.some((v) => v === value);
}

export interface RouteContext {
  store: Store;
  /** Injected in tests so rendered relative times are stable. */
  now?: number;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * A caller that asked for JSON gets JSON; a plain form POST gets a redirect.
 *
 * This is what keeps the dashboard working with JavaScript disabled: the forms
 * are real forms, and the fetch path is an enhancement layered over them rather
 * than a replacement for them.
 */
function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

/**
 * Result of a dismissal, for the fetch path. Counts come back with it so the
 * page can update its tallies without a second request.
 */
function dismissResult(store: Store, dismissed: number, appId?: number): Response {
  const body: Record<string, unknown> = { ok: true, dismissed, counts: store.counts() };
  if (appId !== undefined) {
    const releases = store.listAppHistory(appId);
    body["app"] = {
      id: appId,
      total: releases.length,
      // Same three tallies the app page renders, and the same definitions:
      // "inbox" is news awaiting acknowledgement, so history is not in it.
      inbox: releases.filter((r) => r.dismissed_at === null && !r.backfilled).length,
      dismissed: releases.filter((r) => r.dismissed_at !== null).length,
      history: releases.filter((r) => r.backfilled).length,
    };
  }
  return Response.json(body);
}

/** After a mutation, bounce back where the user came from. */
function redirectBack(req: Request, fallback = url("/")): Response {
  const referer = req.headers.get("referer");
  let location = fallback;
  if (referer) {
    try {
      // Only the path — an absolute Referer from another origin must not turn
      // this into an open redirect.
      const parsed = new URL(referer);
      location = parsed.pathname + parsed.search;
    } catch {
      location = fallback;
    }
  }
  return new Response(null, { status: 303, headers: { location } });
}

/**
 * Strip the mount prefix so route matching is written against clean paths.
 * Returns null when the request is outside this app's sub-path.
 */
export function stripBase(pathname: string): string | null {
  if (BASE_PATH === "") return pathname;
  if (pathname === BASE_PATH) return "/";
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return null;
}

export async function handle(req: Request, ctx: RouteContext): Promise<Response> {
  const requestUrl = new URL(req.url);
  const path = stripBase(requestUrl.pathname);

  // /healthz stays outside the mount prefix so an uptime check doesn't need to
  // know where the dashboard is mounted.
  if (requestUrl.pathname === "/healthz" || path === "/healthz") {
    return healthz(ctx.store);
  }
  if (path === null) return new Response("not found\n", { status: 404 });

  const { store } = ctx;
  const method = req.method.toUpperCase();

  if (method === "GET" && path === "/") return inbox(req, ctx, requestUrl);
  if (method === "GET" && path === "/roster") return roster(req, ctx);

  const appMatch = /^\/app\/(\d+)$/.exec(path);
  if (method === "GET" && appMatch) {
    return appPage(req, ctx, Number(appMatch[1]), requestUrl.searchParams.get("hide") === "1");
  }

  if (method === "POST") {
    const denied = requireAdmin(req);
    if (denied) return denied;

    const dismissMatch = /^\/api\/releases\/(\d+)\/dismiss$/.exec(path);
    if (dismissMatch) {
      const id = Number(dismissMatch[1]);
      const changed = store.dismiss(id);
      if (wantsJson(req)) {
        const release = store.getRelease(id);
        return dismissResult(store, changed ? 1 : 0, release?.app_id);
      }
      return redirectBack(req);
    }

    if (path === "/api/releases/dismiss-all") {
      const n = store.dismissAll();
      console.log(`[web] dismissed ${n} releases`);
      return wantsJson(req) ? dismissResult(store, n) : redirectBack(req);
    }

    const appDismissMatch = /^\/api\/apps\/(\d+)\/dismiss-all$/.exec(path);
    if (appDismissMatch) {
      const appId = Number(appDismissMatch[1]);
      const n = store.dismissAll(appId);
      console.log(`[web] dismissed ${n} releases for app ${appId}`);
      return wantsJson(req)
        ? dismissResult(store, n, appId)
        : redirectBack(req, url(`/app/${appId}`));
    }

    if (path === "/api/apps") return addApp(req, store);

    const deleteMatch = /^\/api\/apps\/(\d+)\/delete$/.exec(path);
    if (deleteMatch) {
      store.deactivateApp(Number(deleteMatch[1]));
      return redirectBack(req, url("/roster"));
    }
  }

  // DELETE is accepted alongside the form POST so the documented API shape in
  // DESIGN §5.1 works for a curl caller.
  const deleteMatch = /^\/api\/apps\/(\d+)$/.exec(path);
  if (method === "DELETE" && deleteMatch) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const removed = store.deactivateApp(Number(deleteMatch[1]));
    return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
  }

  return new Response("not found\n", { status: 404 });
}

function healthz(store: Store): Response {
  try {
    const counts = store.counts();
    return Response.json({ ok: true, ...counts, last_fetch: store.lastFetchedAt() });
  } catch (err) {
    // "Process up" and "store readable" are different facts, and an uptime
    // check wants to be able to tell them apart.
    console.error("[web] healthz: store unreadable:", err);
    return Response.json({ ok: false, error: "store unreadable" }, { status: 503 });
  }
}

function inbox(req: Request, ctx: RouteContext, requestUrl: URL): Response {
  const { store } = ctx;
  // A bogus ?verdict= falls back to "no filter" rather than erroring.
  const rawVerdict = requestUrl.searchParams.get("verdict");
  const verdict = isVerdict(rawVerdict) ? rawVerdict : undefined;
  const all = requestUrl.searchParams.get("all") === "1";
  const appId = Number(requestUrl.searchParams.get("app")) || undefined;

  const releases = store.listReleases({
    // "All" means all: dismissed rows and backfilled history alike. Both are
    // hidden from the default view, for different reasons (see listReleases).
    includeDismissed: all,
    includeBackfilled: all,
    ...(verdict ? { verdict } : {}),
    ...(appId ? { appId } : {}),
    limit: 300,
  });

  return htmlResponse(
    renderInbox({
      releases,
      apps: store.listApps(),
      isAdmin: identify(req).isAdmin,
      verdict,
      all,
      counts: store.counts(),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    }),
  );
}

function appPage(
  req: Request,
  ctx: RouteContext,
  id: number,
  hideDismissed: boolean,
): Response {
  const app = ctx.store.getApp(id);
  if (!app) return new Response("no such app\n", { status: 404 });

  return htmlResponse(
    renderApp({
      app,
      // Always fetch everything: the page reports counts across all three
      // states, and `hideDismissed` only decides what is rendered.
      releases: ctx.store.listAppHistory(id),
      isAdmin: identify(req).isAdmin,
      counts: ctx.store.counts(),
      hideDismissed,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    }),
  );
}

function roster(req: Request, ctx: RouteContext): Response {
  return htmlResponse(
    renderRoster({
      apps: ctx.store.listApps({ includeInactive: true }),
      isAdmin: identify(req).isAdmin,
      counts: ctx.store.counts(),
    }),
  );
}

async function addApp(req: Request, store: Store): Promise<Response> {
  const form = await readForm(req);
  const kind = form.get("kind");
  const ref = form.get("ref")?.trim();

  if (!ref || (kind !== "github" && kind !== "rss")) {
    return new Response("kind must be github or rss, and ref is required\n", { status: 400 });
  }

  const name = form.get("name")?.trim() || defaultName(kind, ref);
  const app = store.upsertApp({ name, kind, ref });
  console.log(`[web] roster: added ${kind}:${ref} as #${app.id}`);

  // A JSON caller gets the row back; a browser gets sent to the roster page.
  if (req.headers.get("accept")?.includes("application/json")) {
    return Response.json(app, { status: 201 });
  }
  return redirectBack(req, url("/roster"));
}

/** Accept both a form POST from the dashboard and a JSON POST from curl. */
async function readForm(req: Request): Promise<Map<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  const entries = new Map<string, string>();

  if (contentType.includes("application/json")) {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") entries.set(k, v);
      }
    }
    return entries;
  }

  const form = await req.formData();
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") entries.set(k, v);
  }
  return entries;
}

/**
 * A sensible display name so the roster form's name field can stay optional.
 * Shares its rule with the roster import, so an app added through the dashboard
 * is named the same way as one that came from Miniflux.
 */
export function defaultName(kind: AppKind, ref: string): string {
  return deriveAppName(kind, ref);
}
