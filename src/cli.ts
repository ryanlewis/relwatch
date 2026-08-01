// Reading the store without going through the service.
//
// The HTTP surface is what to reach for across a network. This is for a shell
// already on the host — a rounds pass over ssh, a look at what is queued before
// a restart, anything at all while the service is stopped. Bare `relwatch` runs
// the service exactly as before; a subcommand reads and exits.
//
// It renders the same view objects the routes do, through the same renderers in
// `web/formats.ts`, so the CLI cannot develop its own idea of what the inbox is.
// The only thing it owns is argv.
//
// The store is opened read-only by the caller (see `StoreOptions.readonly`),
// which is what makes a read safe against a service that is running.
import type { Store, Verdict } from "./db.js";
import {
  appJson,
  appMarkdown,
  inboxJson,
  inboxMarkdown,
  rosterJson,
  rosterMarkdown,
} from "./web/formats.js";
import { buildAppView, buildInboxView, buildRosterView } from "./web/views.js";

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

const VERDICTS: readonly Verdict[] = ["major", "interesting", "maintenance"];

export const USAGE = `relwatch — release tracker

Usage:
  relwatch                     run the service: poll, triage, digest, dashboard
  relwatch inbox [options]     news awaiting acknowledgement
  relwatch app <id> [options]  one app's history
  relwatch roster [options]    the tracked roster, removed apps included
  relwatch help

Options:
  --json           machine-readable output
  --md             markdown (the default)
  --all            inbox: include dismissed releases and backfilled history
  --verdict=<v>    inbox: major | interesting | maintenance
  --app=<id>       inbox: one app only
  --hide           app: list the inbox only, hiding dismissed

Reads RW_DB read-only, so it works with the service running or stopped.
Dismissing is a mutation and goes through the HTTP surface — see README.
`;

interface Options {
  json: boolean;
  all: boolean;
  hide: boolean;
  verdict?: Verdict;
  appId?: number;
}

function fail(message: string): CliResult {
  return { stdout: "", stderr: `relwatch: ${message}\n`, code: 1 };
}

/**
 * Parse the flags, rejecting anything unrecognised.
 *
 * Deliberately stricter than the query string, which falls back to the page on
 * a bogus `?verdict=`. A browser shows you what it did; a mistyped flag in a
 * script is answered silently and read as the truth, and this project exists
 * because things were quietly not arriving.
 */
function parseOptions(args: readonly string[]): Options | { error: string } {
  const opts: Options = { json: false, all: false, hide: false };

  for (const arg of args) {
    const [flag, value] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    switch (flag) {
      case "--json": {
        opts.json = true;
        break;
      }
      case "--md":
      case "--markdown": {
        opts.json = false;
        break;
      }
      case "--all": {
        opts.all = true;
        break;
      }
      case "--hide": {
        opts.hide = true;
        break;
      }
      case "--verdict": {
        const verdict = VERDICTS.find((v) => v === value);
        if (!verdict) return { error: `--verdict must be one of ${VERDICTS.join(", ")}` };
        opts.verdict = verdict;
        break;
      }
      case "--app": {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) return { error: "--app must be an app id" };
        opts.appId = id;
        break;
      }
      default: {
        return { error: `unknown option ${flag}` };
      }
    }
  }

  return opts;
}

/**
 * Run one subcommand. `openStore` is a thunk rather than a Store so that a
 * store that cannot be opened at all — the usual cause being an `RW_DB` that
 * points nowhere — is reported as a CLI error instead of a stack trace.
 */
export function runCli(
  argv: readonly string[],
  openStore: () => Store,
  now?: number,
): CliResult {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { stdout: USAGE, stderr: "", code: 0 };
  }
  if (command !== "inbox" && command !== "app" && command !== "roster") {
    return fail(`unknown command "${command}"\n\n${USAGE}`);
  }

  // `app` takes its id positionally, before the flags.
  let appArg: string | undefined;
  let flags = rest;
  if (command === "app") {
    [appArg, ...flags] = rest;
    if (appArg === undefined) return fail(`app needs an id — see "relwatch roster"`);
  }

  const parsed = parseOptions(flags);
  if ("error" in parsed) return fail(parsed.error);

  let store: Store;
  try {
    store = openStore();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`cannot open the store: ${message}`);
  }

  // The store is left open: the caller owns its lifetime, and the only real
  // one exits the process on return. Closing here would buy nothing and would
  // stop a second command reading the same handle.
  try {
    return { stdout: run(command, store, parsed, appArg, now), stderr: "", code: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

function run(
  command: "inbox" | "app" | "roster",
  store: Store,
  opts: Options,
  appArg: string | undefined,
  now: number | undefined,
): string {
  if (command === "roster") {
    const view = buildRosterView(store);
    return opts.json ? stringify(rosterJson(view)) : rosterMarkdown(view);
  }

  if (command === "app") {
    const id = Number(appArg);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`"${String(appArg)}" is not an app id`);
    const view = buildAppView(store, id, { hideDismissed: opts.hide, now });
    if (!view) throw new Error(`no app ${id} — see "relwatch roster"`);
    return opts.json ? stringify(appJson(view)) : appMarkdown(view);
  }

  const view = buildInboxView(store, {
    all: opts.all,
    verdict: opts.verdict,
    appId: opts.appId,
    now,
  });
  return opts.json ? stringify(inboxJson(view)) : inboxMarkdown(view);
}

/** Indented, because the reader is a terminal or an agent, not a socket. */
function stringify(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}
