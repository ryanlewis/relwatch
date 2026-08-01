// The CLI. Its whole job is argv — the rendering is `web/formats.ts`, already
// covered there — so these lean on the parsing, the exit codes, and the one
// property that matters: that it answers the same question the routes do.
import { describe, expect, test } from "bun:test";
import { runCli, USAGE } from "./cli.js";
import { Store } from "./db.js";
import { handle } from "./web/routes.js";

const NOW = Date.parse("2026-08-01T09:00:00.000Z");

interface Fixture {
  store: Store;
  nvimId: number;
  bunId: number;
  majorId: number;
}

function seeded(): Fixture {
  const store = new Store(":memory:");
  const nvim = store.upsertApp({
    name: "Neovim",
    kind: "github",
    ref: "neovim/neovim",
    homepage: "https://neovim.io",
  });
  const bun = store.upsertApp({ name: "Bun", kind: "github", ref: "oven-sh/bun" });

  const major = store.insertRelease({
    app_id: nvim.id,
    ext_id: "r1",
    tag: "v0.12.0",
    url: "https://github.com/neovim/neovim/releases/tag/v0.12.0",
    published_at: "2026-07-30T10:00:00.000Z",
  })!;
  store.saveTriage(major.id, {
    verdict: "major",
    summary: "Rewrites the LSP client.",
    breaking: true,
    highlights: ["vim.lsp.config() replaces lspconfig"],
  });

  const maint = store.insertRelease({
    app_id: bun.id,
    ext_id: "r2",
    tag: "v1.3.9",
    published_at: "2026-07-29T09:00:00.000Z",
  })!;
  store.saveTriage(maint.id, {
    verdict: "maintenance",
    summary: "Bug fixes.",
    breaking: false,
    highlights: [],
  });
  store.dismiss(maint.id);

  store.insertRelease({
    app_id: nvim.id,
    ext_id: "r0",
    tag: "v0.9.0",
    published_at: "2021-01-01T00:00:00.000Z",
    backfilled: true,
  });

  return { store, nvimId: nvim.id, bunId: bun.id, majorId: major.id };
}

/** Every command against one store, which is what lets a test compare two. */
function cli(store: Store, ...argv: string[]) {
  return runCli(argv, () => store, NOW);
}

function parsedJson(stdout: string): Record<string, unknown> {
  const body: unknown = JSON.parse(stdout);
  if (typeof body !== "object" || body === null) throw new Error("expected a JSON object");
  return { ...body };
}

function releasesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const items: unknown = body["releases"];
  if (!Array.isArray(items)) throw new Error("expected a releases array");
  return items.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("expected release objects");
    return { ...item };
  });
}

// --- usage and argv --------------------------------------------------------

describe("usage", () => {
  test("no arguments is the caller's business, not the CLI's", () => {
    // Bare `relwatch` runs the service; index.ts never calls in without args.
    // Asked directly, help is the only sensible answer.
    expect(runCli([], () => new Store(":memory:")).code).toBe(0);
  });

  test("help is success on stdout, so it can be piped", () => {
    for (const arg of ["help", "--help", "-h"]) {
      const result = runCli([arg], () => new Store(":memory:"));
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toBe(USAGE);
    }
  });

  test("an unknown command fails loudly, and never starts the service", () => {
    const result = runCli(["inbx"], () => new Store(":memory:"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown command "inbx"');
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  test("a mistyped flag is an error rather than a silently different answer", () => {
    const { store } = seeded();
    const result = cli(store, "inbox", "--verdct=major");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown option --verdct");
  });

  test("rejects a verdict or app id it cannot honour", () => {
    expect(runCli(["inbox", "--verdict=urgent"], () => new Store(":memory:")).stderr).toContain(
      "--verdict must be one of major, interesting, maintenance",
    );
    expect(runCli(["inbox", "--app=nope"], () => new Store(":memory:")).stderr).toContain(
      "--app must be an app id",
    );
    expect(runCli(["inbox", "--app=0"], () => new Store(":memory:")).stderr).toContain(
      "--app must be an app id",
    );
  });

  test("reports a store it cannot open instead of stack-tracing", () => {
    const result = runCli(["inbox"], () => {
      throw new Error("unable to open database file");
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot open the store: unable to open database file");
  });
});

// --- inbox -----------------------------------------------------------------

describe("relwatch inbox", () => {
  test("defaults to markdown, because the reader is a terminal", () => {
    const { store, majorId } = seeded();
    const { stdout, code } = cli(store, "inbox");
    expect(code).toBe(0);
    expect(stdout).toContain("# relwatch — inbox");
    expect(stdout).toContain("### Neovim — v0.12.0 `major` `breaking`");
    expect(stdout).toContain(`id ${majorId} ·`);
  });

  test("--json is indented, and parses", () => {
    const { store } = seeded();
    const { stdout } = cli(store, "inbox", "--json");
    expect(stdout).toContain("\n  ");
    expect(parsedJson(stdout)["view"]).toBe("inbox");
  });

  test("--md wins when both are given, because the last word is the flag's", () => {
    const { store } = seeded();
    expect(cli(store, "inbox", "--json", "--md").stdout).toContain("# relwatch — inbox");
  });

  test("excludes dismissed and backfilled by default, includes both with --all", () => {
    const { store } = seeded();
    expect(releasesOf(parsedJson(cli(store, "inbox", "--json").stdout))).toHaveLength(1);

    const all = releasesOf(parsedJson(cli(store, "inbox", "--all", "--json").stdout));
    expect(all).toHaveLength(3);
    expect(all.some((r) => r["backfilled"] === true)).toBe(true);
    expect(all.some((r) => r["dismissed_at"] !== null)).toBe(true);
  });

  test("--verdict and --app narrow the same way the query string does", () => {
    const { store, nvimId } = seeded();
    const byVerdict = parsedJson(cli(store, "inbox", "--verdict=major", "--json").stdout);
    expect(byVerdict["filter"]).toMatchObject({ verdict: "major" });
    expect(releasesOf(byVerdict)).toHaveLength(1);

    const byApp = parsedJson(cli(store, "inbox", `--app=${nvimId}`, "--json").stdout);
    expect(byApp["filter"]).toMatchObject({ app: nvimId });
  });

  test("says inbox zero rather than printing nothing", () => {
    const store = new Store(":memory:");
    expect(cli(store, "inbox").stdout).toContain("Inbox zero — no news waiting.");
  });
});

// --- app and roster --------------------------------------------------------

describe("relwatch app", () => {
  test("takes the id positionally, before the flags", () => {
    const { store, nvimId } = seeded();
    const { stdout, code } = cli(store, "app", String(nvimId), "--json");
    expect(code).toBe(0);
    expect(parsedJson(stdout)["app"]).toMatchObject({ id: nvimId, name: "Neovim" });
  });

  test("--hide narrows the list but not the tallies", () => {
    const { store, nvimId } = seeded();
    const body = parsedJson(cli(store, "app", String(nvimId), "--hide", "--json").stdout);
    expect(body["tallies"]).toEqual({ total: 2, inbox: 1, dismissed: 0, history: 1 });
    expect(releasesOf(body)).toHaveLength(1);
  });

  test("points at the roster when the id is missing or unknown", () => {
    const { store } = seeded();
    expect(cli(store, "app").stderr).toContain('app needs an id — see "relwatch roster"');
    expect(cli(store, "app", "999").stderr).toContain('no app 999 — see "relwatch roster"');
    expect(cli(store, "app", "banana").stderr).toContain('"banana" is not an app id');
    expect(cli(store, "app", "999").code).toBe(1);
  });
});

describe("relwatch roster", () => {
  test("renders a table carrying the ids the app command needs", () => {
    const { store, nvimId } = seeded();
    const { stdout } = cli(store, "roster");
    expect(stdout).toContain("| Id | Name | Kind | Reference | State |");
    expect(stdout).toContain(`| ${nvimId} | Neovim | github | neovim/neovim | active |`);
  });

  test("keeps a removed app listed, because removal is soft", () => {
    const { store, bunId } = seeded();
    store.deactivateApp(bunId);
    expect(cli(store, "roster").stdout).toContain("| Bun | github | oven-sh/bun | removed |");
  });
});

// --- the CLI and the routes agree ------------------------------------------

describe("the CLI and the HTTP surface", () => {
  test("answer the same question identically", async () => {
    const { store, nvimId } = seeded();
    const cases: [string, string[]][] = [
      ["/?format=json", ["inbox", "--json"]],
      ["/?all=1&format=json", ["inbox", "--all", "--json"]],
      ["/?verdict=major&format=json", ["inbox", "--verdict=major", "--json"]],
      [`/app/${nvimId}?format=json`, ["app", String(nvimId), "--json"]],
      [`/app/${nvimId}?hide=1&format=json`, ["app", String(nvimId), "--hide", "--json"]],
      ["/roster?format=json", ["roster", "--json"]],
    ];

    for (const [path, argv] of cases) {
      const res = await handle(new Request(`http://localhost${path}`), { store, now: NOW });
      // oxlint-disable-next-line no-await-in-loop -- one shared store, read in order
      const overHttp: unknown = await res.json();
      const overCli: unknown = JSON.parse(cli(store, ...argv).stdout);
      expect(overCli).toEqual(overHttp);
    }
  });

  test("render markdown identically too", async () => {
    const { store } = seeded();
    const res = await handle(new Request("http://localhost/?format=md"), { store, now: NOW });
    expect(cli(store, "inbox").stdout).toBe(await res.text());
  });
});

// --- read-only store -------------------------------------------------------

describe("a read-only store", () => {
  const dbPath = `/tmp/relwatch-cli-test-${process.pid}.db`;

  test("reads a database the service has open, and refuses to write it", () => {
    const writable = new Store(dbPath);
    writable.upsertApp({ name: "Neovim", kind: "github", ref: "neovim/neovim" });

    const reader = new Store(dbPath, { readonly: true });
    expect(reader.listApps()).toHaveLength(1);
    expect(reader.counts().apps).toBe(1);
    // The point of the mode: a stale binary cannot migrate the schema out from
    // under a running service, and a read cannot become a write by accident.
    expect(() => reader.upsertApp({ name: "Bun", kind: "github", ref: "oven-sh/bun" })).toThrow();
    reader.close();
    writable.close();
  });

  test("refuses a path that isn't there rather than creating an empty one", () => {
    expect(() => new Store(`${dbPath}.missing`, { readonly: true })).toThrow();
    expect(Bun.file(`${dbPath}.missing`).size).toBe(0);
  });
});
