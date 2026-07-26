import { describe, expect, test } from "bun:test";
import { BASE_PATH } from "../config.js";
import { Store } from "../db.js";
import { identify, loginUrl, requireAdmin, url } from "./auth.js";
import { h, html, layout, raw, safeUrl, timeAgo } from "./html.js";
import { defaultName, handle, stripBase } from "./routes.js";

const ADMIN = "you@example.com";

function req(
  path: string,
  init: { method?: string; email?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.email) headers["x-exedev-email"] = init.email;
  return new Request(`http://localhost${url(path)}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

function form(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  const data = new URLSearchParams(fields);
  return {
    body: data.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

/** Read a JSON body as a record without asserting a shape that isn't checked. */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("expected a JSON object");
  return { ...body };
}

function seeded(): { store: Store; appId: number; releaseId: number } {
  const store = new Store(":memory:");
  const app = store.upsertApp({
    name: "Neovim",
    kind: "github",
    ref: "neovim/neovim",
    homepage: "https://neovim.io",
  });
  const release = store.insertRelease({
    app_id: app.id,
    ext_id: "r1",
    tag: "v0.12.0",
    title: "v0.12.0",
    url: "https://github.com/neovim/neovim/releases/tag/v0.12.0",
    published_at: "2026-07-06T10:00:00.000Z",
  })!;
  store.saveTriage(release.id, {
    verdict: "major",
    summary: "A big release.",
    breaking: true,
    highlights: ["First thing", "Second thing"],
  });
  return { store, appId: app.id, releaseId: release.id };
}

// --- escaping --------------------------------------------------------------

describe("h", () => {
  test("escapes the characters that break out of text and attributes", () => {
    expect(h(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  test("renders null and undefined as nothing", () => {
    expect(h(null)).toBe("");
    expect(h(undefined)).toBe("");
  });

  test("stringifies non-strings", () => {
    expect(h(42)).toBe("42");
    expect(h(true)).toBe("true");
  });
});

describe("html tag", () => {
  test("escapes interpolations by default", () => {
    const evil = '<img src=x onerror="alert(1)">';
    expect(html`<p>${evil}</p>`.value).not.toContain("<img");
    expect(html`<p>${evil}</p>`.value).toContain("&lt;img");
  });

  test("does not double-escape nested SafeHtml", () => {
    const inner = html`<b>bold</b>`;
    expect(html`<p>${inner}</p>`.value).toBe("<p><b>bold</b></p>");
  });

  test("joins arrays so map() composes without a manual join", () => {
    expect(html`${[1, 2, 3].map((n) => html`<li>${n}</li>`)}`.value).toBe(
      "<li>1</li><li>2</li><li>3</li>",
    );
  });

  test("renders null, undefined and false as nothing, so `cond && x` works", () => {
    expect(html`<p>${null}${undefined}${false}</p>`.value).toBe("<p></p>");
  });

  test("raw() opts out deliberately", () => {
    expect(html`${raw("<b>x</b>")}`.value).toBe("<b>x</b>");
  });
});

describe("safeUrl", () => {
  test("allows http, https and site-relative links", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("/app/1")).toBe("/app/1");
  });

  test("drops javascript: and data: URLs from upstream feeds", () => {
    // Release payloads are upstream data; a javascript: link in a feed would
    // otherwise be a working XSS vector on the dashboard.
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("  JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl("")).toBeNull();
  });
});

describe("layout", () => {
  test("emits a complete document with an escaped title", () => {
    const out = layout({ title: "<hack>", body: html`<p>hi</p>` });
    expect(out).toStartWith("<!doctype html>");
    expect(out).toContain("&lt;hack&gt;");
    expect(out).toContain("<p>hi</p>");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");

  test("uses relative time while it is useful", () => {
    expect(timeAgo("2026-07-26T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-07-26T11:30:00Z", now)).toBe("30m ago");
    expect(timeAgo("2026-07-26T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-07-24T12:00:00Z", now)).toBe("2d ago");
  });

  test("falls back to a date once relative stops helping", () => {
    expect(timeAgo("2026-01-01T12:00:00Z", now)).toBe("2026-01-01");
  });

  test("renders nothing for a missing or unparseable date", () => {
    expect(timeAgo(null, now)).toBe("");
    expect(timeAgo("not a date", now)).toBe("");
  });
});

// --- auth ------------------------------------------------------------------

describe("identify", () => {
  test("reads the proxy-injected email, case-insensitively", () => {
    expect(identify(req("/", { email: "You@EXAMPLE.com" })).isAdmin).toBe(true);
    expect(identify(req("/", { email: ADMIN })).email).toBe(ADMIN);
  });

  test("treats a non-admin email as signed in but not privileged", () => {
    const identity = identify(req("/", { email: "someone@else.com" }));
    expect(identity.email).toBe("someone@else.com");
    expect(identity.isAdmin).toBe(false);
  });

  test("treats a missing header as anonymous", () => {
    const identity = identify(req("/"));
    expect(identity.email).toBeNull();
    expect(identity.isAdmin).toBe(false);
  });

  test("reads the user id header when present", () => {
    expect(identify(req("/", { headers: { "x-exedev-userid": "u123" } })).userId).toBe("u123");
  });
});

describe("requireAdmin", () => {
  test("lets an admin through", () => {
    expect(requireAdmin(req("/", { email: ADMIN }))).toBeNull();
  });

  test("bounces an anonymous caller to the proxy's login", () => {
    const res = requireAdmin(req("/"))!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("/__exe.dev/login?redirect=");
  });

  test("403s a signed-in non-admin instead of looping them through login", () => {
    const res = requireAdmin(req("/", { email: "someone@else.com" }))!;
    expect(res.status).toBe(403);
  });
});

describe("loginUrl", () => {
  test("round-trips the current path so login returns the user where they were", () => {
    const target = loginUrl(req("/roster"));
    expect(target).toContain(encodeURIComponent(url("/roster")));
  });
});

describe("url and stripBase", () => {
  test("url prefixes the mount path", () => {
    expect(url("/roster")).toBe(`${BASE_PATH}/roster`);
    expect(url("/")).toBe(`${BASE_PATH}/`);
    // Tolerates a missing leading slash rather than emitting a broken link.
    expect(url("roster")).toBe(`${BASE_PATH}/roster`);
  });

  test("stripBase is url's inverse for in-app paths", () => {
    expect(stripBase(url("/roster"))).toBe("/roster");
    expect(stripBase(BASE_PATH === "" ? "/" : BASE_PATH)).toBe("/");
  });

  test("stripBase rejects paths outside the mount", () => {
    if (BASE_PATH !== "") {
      expect(stripBase("/somewhere-else")).toBeNull();
      // A prefix match must not be a substring match.
      expect(stripBase(`${BASE_PATH}-evil/x`)).toBeNull();
    }
  });
});

describe("defaultName", () => {
  test("uses the repo name for GitHub apps", () => {
    expect(defaultName("github", "neovim/neovim")).toBe("neovim");
    expect(defaultName("github", "cli/cli.git")).toBe("cli");
  });

  test("uses the hostname for feeds", () => {
    expect(defaultName("rss", "https://www.obsidian.md/changelog.xml")).toBe("obsidian.md");
  });

  test("falls back to the raw ref when it isn't a URL", () => {
    expect(defaultName("rss", "not a url")).toBe("not a url");
  });
});

// --- routes ----------------------------------------------------------------

describe("GET /healthz", () => {
  test("reports counts and is reachable outside the mount prefix", async () => {
    const { store } = seeded();
    const res = await handle(new Request("http://localhost/healthz"), { store });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body["ok"]).toBe(true);
    expect(body["apps"]).toBe(1);
    expect(body["releases"]).toBe(1);
    store.close();
  });

  test("503s when the store is unreadable, so uptime can tell it apart", async () => {
    const { store } = seeded();
    store.close(); // simulate a broken store
    const res = await handle(new Request("http://localhost/healthz"), { store });
    expect(res.status).toBe(503);
  });
});

describe("GET /", () => {
  test("renders the inbox with verdict, breaking flag and highlights", async () => {
    const { store } = seeded();
    const res = await handle(req("/"), { store });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Neovim");
    expect(body).toContain("v0.12.0");
    expect(body).toContain("A big release.");
    expect(body).toContain("breaking");
    expect(body).toContain("First thing");
    store.close();
  });

  test("hides dismissed releases by default and shows them with ?all=1", async () => {
    const { store, releaseId } = seeded();
    store.dismiss(releaseId);

    expect(await (await handle(req("/"), { store })).text()).toContain("Inbox zero");
    expect(await (await handle(req("/?all=1"), { store })).text()).toContain("v0.12.0");
    store.close();
  });

  test("filters by verdict and ignores a bogus one", async () => {
    const { store } = seeded();
    expect(await (await handle(req("/?verdict=maintenance"), { store })).text()).toContain(
      "Inbox zero",
    );
    expect(await (await handle(req("/?verdict=major"), { store })).text()).toContain("v0.12.0");
    // A junk filter falls back to "no filter" rather than erroring.
    expect(await (await handle(req("/?verdict=nonsense"), { store })).text()).toContain("v0.12.0");
    store.close();
  });

  test("shows admin affordances only to an admin", async () => {
    const { store } = seeded();

    const anon = await (await handle(req("/"), { store })).text();
    expect(anon).not.toContain("Dismiss all");
    expect(anon).toContain("sign in");

    const admin = await (await handle(req("/", { email: ADMIN }), { store })).text();
    expect(admin).toContain("Dismiss all");
    store.close();
  });

  test("escapes upstream content rather than rendering it", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "<script>alert(1)</script>", kind: "github", ref: "a/b" });
    const rel = store.insertRelease({
      app_id: app.id,
      ext_id: "x",
      tag: "<img src=x onerror=alert(1)>",
      url: "javascript:alert(1)",
    })!;
    store.saveTriage(rel.id, {
      verdict: "major",
      summary: "</p><script>alert(1)</script>",
      breaking: false,
      highlights: ["<b>not bold</b>"],
    });

    const body = await (await handle(req("/"), { store })).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("javascript:alert(1)");
    expect(body).toContain("&lt;script&gt;");
    store.close();
  });

  test("shows an untriaged release as not triaged rather than hiding it", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/b" });
    store.insertRelease({ app_id: app.id, ext_id: "x", tag: "v1" });

    const body = await (await handle(req("/"), { store })).text();
    expect(body).toContain("not triaged");
    expect(body).toContain("v1");
    store.close();
  });

  test("marks backfilled history as history, not as a triage failure", async () => {
    const store = new Store(":memory:");
    const app = store.upsertApp({ name: "A", kind: "github", ref: "a/b" });
    store.insertRelease({ app_id: app.id, ext_id: "x", tag: "v1", backfilled: true });

    const body = await (await handle(req("/"), { store })).text();
    expect(body).toContain("history");
    expect(body).not.toContain("not triaged");
    store.close();
  });
});

describe("GET /app/:id", () => {
  test("renders per-app history including dismissed releases", async () => {
    const { store, appId, releaseId } = seeded();
    store.dismiss(releaseId);

    const body = await (await handle(req(`/app/${appId}`), { store })).text();
    expect(body).toContain("Neovim");
    expect(body).toContain("v0.12.0"); // dismissal hides from the inbox, not here
    expect(body).toContain("neovim.io");
    store.close();
  });

  test("404s an unknown app", async () => {
    const { store } = seeded();
    expect((await handle(req("/app/999"), { store })).status).toBe(404);
    store.close();
  });

  test("labels each release as history and/or dismissed", async () => {
    // Two independent axes — a release can be neither, either, or both — so
    // opacity alone can't convey the state.
    const { store, appId, releaseId } = seeded();
    store.insertRelease({ app_id: appId, ext_id: "old", tag: "v0.1.0", backfilled: true });
    store.dismiss(releaseId);

    const body = await (await handle(req(`/app/${appId}`), { store })).text();
    expect(body).toContain(">history<");
    expect(body).toContain(">dismissed<");
    store.close();
  });

  test("tallies inbox, dismissed and history counts", async () => {
    const { store, appId, releaseId } = seeded();
    store.insertRelease({ app_id: appId, ext_id: "h1", backfilled: true });
    store.insertRelease({ app_id: appId, ext_id: "h2", backfilled: true });
    store.dismiss(releaseId);

    const body = await (await handle(req(`/app/${appId}`), { store })).text();
    expect(body).toContain("3 releases");
    expect(body).toContain("2</strong> in inbox");
    expect(body).toContain("1 dismissed");
    expect(body).toContain("2 history");
    store.close();
  });

  test("?hide=1 renders only the inbox but still counts everything", async () => {
    const { store, appId, releaseId } = seeded();
    store.insertRelease({ app_id: appId, ext_id: "live", tag: "v9.9.9" });
    store.dismiss(releaseId);

    const all = await (await handle(req(`/app/${appId}`), { store })).text();
    expect(all).toContain("v0.12.0");
    expect(all).toContain("v9.9.9");

    const hidden = await (await handle(req(`/app/${appId}?hide=1`), { store })).text();
    expect(hidden).not.toContain("v0.12.0"); // the dismissed one
    expect(hidden).toContain("v9.9.9");
    // Counts still describe the whole app, not just what is rendered.
    expect(hidden).toContain("1 dismissed");
    store.close();
  });

  test("explains the badges only when there is history to explain", async () => {
    const { store, appId } = seeded();
    expect(await (await handle(req(`/app/${appId}`), { store })).text()).not.toContain(
      "never be emailed",
    );

    store.insertRelease({ app_id: appId, ext_id: "h", backfilled: true });
    expect(await (await handle(req(`/app/${appId}`), { store })).text()).toContain(
      "never be emailed",
    );
    store.close();
  });
});

describe("POST /api/apps/:id/dismiss-all", () => {
  test("dismisses only that app's releases", async () => {
    const store = new Store(":memory:");
    const a = store.upsertApp({ name: "A", kind: "github", ref: "a/a" });
    const b = store.upsertApp({ name: "B", kind: "github", ref: "b/b" });
    store.insertRelease({ app_id: a.id, ext_id: "a1" });
    store.insertRelease({ app_id: a.id, ext_id: "a2" });
    store.insertRelease({ app_id: b.id, ext_id: "b1" });

    const res = await handle(
      req(`/api/apps/${a.id}/dismiss-all`, { method: "POST", email: ADMIN }),
      { store },
    );

    expect(res.status).toBe(303);
    // Clearing one noisy project must not clear everything else with it.
    expect(store.listReleases().map((r) => r.ext_id)).toEqual(["b1"]);
    store.close();
  });

  test("redirects back to the app page", async () => {
    const { store, appId } = seeded();
    const res = await handle(
      req(`/api/apps/${appId}/dismiss-all`, { method: "POST", email: ADMIN }),
      { store },
    );
    expect(res.headers.get("location")).toBe(url(`/app/${appId}`));
    store.close();
  });

  test("is gated like every other mutation", async () => {
    const { store, appId } = seeded();
    const res = await handle(req(`/api/apps/${appId}/dismiss-all`, { method: "POST" }), { store });
    expect(res.status).toBe(302);
    expect(store.listReleases()).toHaveLength(1);
    store.close();
  });

  test("shows the button only to an admin, and only with something to dismiss", async () => {
    const { store, appId, releaseId } = seeded();

    expect(await (await handle(req(`/app/${appId}`), { store })).text()).not.toContain(
      "Dismiss all",
    );
    expect(
      await (await handle(req(`/app/${appId}`, { email: ADMIN }), { store })).text(),
    ).toContain("Dismiss all 1 in Neovim");

    store.dismiss(releaseId);
    expect(
      await (await handle(req(`/app/${appId}`, { email: ADMIN }), { store })).text(),
    ).not.toContain("Dismiss all");
    store.close();
  });
});

describe("GET /roster", () => {
  test("lists apps, with the add form for admins only", async () => {
    const { store } = seeded();

    const anon = await (await handle(req("/roster"), { store })).text();
    expect(anon).toContain("neovim/neovim");
    expect(anon).not.toContain("Add");

    const admin = await (await handle(req("/roster", { email: ADMIN }), { store })).text();
    expect(admin).toContain("owner/repo or feed URL");
    expect(admin).toContain("Remove");
    store.close();
  });

  test("shows removed apps as restorable", async () => {
    const { store, appId } = seeded();
    store.deactivateApp(appId);
    const body = await (await handle(req("/roster", { email: ADMIN }), { store })).text();
    expect(body).toContain("Restore");
    store.close();
  });
});

describe("mutations require admin", () => {
  test("dismiss redirects an anonymous caller to login and changes nothing", async () => {
    const { store, releaseId } = seeded();
    const res = await handle(req(`/api/releases/${releaseId}/dismiss`, { method: "POST" }), {
      store,
    });

    expect(res.status).toBe(302);
    expect(store.listReleases()).toHaveLength(1); // untouched
    store.close();
  });

  test("dismiss 403s a signed-in non-admin", async () => {
    const { store, releaseId } = seeded();
    const res = await handle(
      req(`/api/releases/${releaseId}/dismiss`, { method: "POST", email: "someone@else.com" }),
      { store },
    );
    expect(res.status).toBe(403);
    expect(store.listReleases()).toHaveLength(1);
    store.close();
  });

  test("dismiss-all is gated too", async () => {
    const { store } = seeded();
    const res = await handle(req("/api/releases/dismiss-all", { method: "POST" }), { store });
    expect(res.status).toBe(302);
    expect(store.listReleases()).toHaveLength(1);
    store.close();
  });

  test("adding an app is gated", async () => {
    const { store } = seeded();
    const res = await handle(
      req("/api/apps", { method: "POST", ...form({ kind: "github", ref: "x/y" }) }),
      { store },
    );
    expect(res.status).toBe(302);
    expect(store.listApps()).toHaveLength(1);
    store.close();
  });

  test("removing an app is gated", async () => {
    const { store, appId } = seeded();
    const res = await handle(req(`/api/apps/${appId}/delete`, { method: "POST" }), { store });
    expect(res.status).toBe(302);
    expect(store.listApps()).toHaveLength(1);
    store.close();
  });
});

describe("POST /api/releases/:id/dismiss", () => {
  test("dismisses and redirects back", async () => {
    const { store, releaseId } = seeded();
    const res = await handle(
      req(`/api/releases/${releaseId}/dismiss`, {
        method: "POST",
        email: ADMIN,
        headers: { referer: `http://localhost${url("/")}?all=1` },
      }),
      { store },
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${url("/")}?all=1`);
    expect(store.listReleases()).toHaveLength(0);
    // Dismissal also pulls it from a digest that hasn't gone out.
    expect(store.digestSet()).toHaveLength(0);
    store.close();
  });

  test("does not turn an off-origin Referer into an open redirect", async () => {
    const { store, releaseId } = seeded();
    const res = await handle(
      req(`/api/releases/${releaseId}/dismiss`, {
        method: "POST",
        email: ADMIN,
        headers: { referer: "https://evil.example.com/phish" },
      }),
      { store },
    );
    expect(res.headers.get("location")).toBe("/phish");
    expect(res.headers.get("location")).not.toContain("evil.example.com");
    store.close();
  });

  test("falls back to the inbox when the Referer is unusable", async () => {
    const { store, releaseId } = seeded();
    const res = await handle(
      req(`/api/releases/${releaseId}/dismiss`, {
        method: "POST",
        email: ADMIN,
        headers: { referer: "::: not a url :::" },
      }),
      { store },
    );
    expect(res.headers.get("location")).toBe(url("/"));
    store.close();
  });
});

describe("POST /api/releases/dismiss-all", () => {
  test("clears the decks without deleting anything", async () => {
    const { store } = seeded();
    const res = await handle(
      req("/api/releases/dismiss-all", { method: "POST", email: ADMIN }),
      { store },
    );

    expect(res.status).toBe(303);
    expect(store.listReleases()).toHaveLength(0);
    expect(store.counts().releases).toBe(1); // hidden, not deleted
    store.close();
  });
});

describe("POST /api/apps", () => {
  test("adds an app from a form post", async () => {
    const { store } = seeded();
    const res = await handle(
      req("/api/apps", {
        method: "POST",
        email: ADMIN,
        ...form({ kind: "github", ref: "cli/cli" }),
      }),
      { store },
    );

    expect(res.status).toBe(303);
    const added = store.listApps().find((a) => a.ref === "cli/cli");
    expect(added?.name).toBe("cli"); // name defaulted from the ref
    store.close();
  });

  test("accepts JSON and returns the row for a curl caller", async () => {
    const { store } = seeded();
    const res = await handle(
      req("/api/apps", {
        method: "POST",
        email: ADMIN,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ kind: "rss", ref: "https://example.com/feed", name: "Example" }),
      }),
      { store },
    );

    expect(res.status).toBe(201);
    expect((await jsonBody(res))["name"]).toBe("Example");
    store.close();
  });

  test("rejects a missing ref or an unknown kind", async () => {
    const { store } = seeded();

    const noRef = await handle(
      req("/api/apps", { method: "POST", email: ADMIN, ...form({ kind: "github", ref: "  " }) }),
      { store },
    );
    expect(noRef.status).toBe(400);

    const badKind = await handle(
      req("/api/apps", { method: "POST", email: ADMIN, ...form({ kind: "gopher", ref: "x" }) }),
      { store },
    );
    expect(badKind.status).toBe(400);
    expect(store.listApps()).toHaveLength(1);
    store.close();
  });

  test("re-adding a removed app restores it with its history", async () => {
    const { store, appId } = seeded();
    store.deactivateApp(appId);

    await handle(
      req("/api/apps", {
        method: "POST",
        email: ADMIN,
        ...form({ kind: "github", ref: "neovim/neovim", name: "Neovim" }),
      }),
      { store },
    );

    expect(store.listApps()).toHaveLength(1);
    expect(store.listAppHistory(appId)).toHaveLength(1);
    store.close();
  });
});

describe("app removal", () => {
  test("POST .../delete soft-removes and keeps the history", async () => {
    const { store, appId } = seeded();
    const res = await handle(
      req(`/api/apps/${appId}/delete`, { method: "POST", email: ADMIN }),
      { store },
    );

    expect(res.status).toBe(303);
    expect(store.listApps()).toHaveLength(0);
    // The archive the dashboard exists to show is still there.
    expect(store.listAppHistory(appId)).toHaveLength(1);
    store.close();
  });

  test("DELETE /api/apps/:id works for a curl caller", async () => {
    const { store, appId } = seeded();
    const res = await handle(
      req(`/api/apps/${appId}`, { method: "DELETE", email: ADMIN }),
      { store },
    );

    expect(res.status).toBe(200);
    expect(store.listApps()).toHaveLength(0);
    store.close();
  });

  test("DELETE of an unknown app is a 404", async () => {
    const { store } = seeded();
    const res = await handle(req("/api/apps/999", { method: "DELETE", email: ADMIN }), { store });
    expect(res.status).toBe(404);
    store.close();
  });

  test("DELETE is gated like every other mutation", async () => {
    const { store, appId } = seeded();
    const res = await handle(req(`/api/apps/${appId}`, { method: "DELETE" }), { store });
    expect(res.status).toBe(302);
    expect(store.listApps()).toHaveLength(1);
    store.close();
  });
});

describe("unknown routes", () => {
  test("404 inside the mount", async () => {
    const { store } = seeded();
    expect((await handle(req("/nope"), { store })).status).toBe(404);
    store.close();
  });

  test("404 outside the mount", async () => {
    const { store } = seeded();
    const res = await handle(new Request("http://localhost/elsewhere"), { store });
    expect(res.status).toBe(404);
    store.close();
  });

  test("404 for a POST to an unrouted admin path", async () => {
    const { store } = seeded();
    const res = await handle(req("/api/nope", { method: "POST", email: ADMIN }), { store });
    expect(res.status).toBe(404);
    store.close();
  });
});
