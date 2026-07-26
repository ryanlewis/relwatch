#!/usr/bin/env bun
// Seed a relwatch DB from roster.json, then optionally backfill history.
//
//   bun scripts/seed-roster.ts roster.json            # roster only
//   bun scripts/seed-roster.ts roster.json --backfill # + last N per app
//
// Backfilled rows are marked `backfilled = 1`: browsable as history, never
// triaged, never emailed. That is how the dashboard opens with context without
// the old 108-entry Miniflux backlog transferring (DESIGN §6.1).
import { BACKFILL_DEPTH, DB_PATH } from "../src/config.js";
import { Store, type AppKind } from "../src/db.js";
import { poll } from "../src/poll.js";

interface RosterEntry {
  name: string;
  kind: AppKind;
  ref: string;
  homepage?: string | null;
}

function parseRoster(raw: string): RosterEntry[] {
  const body: unknown = JSON.parse(raw);
  if (!Array.isArray(body)) throw new Error("roster file must contain a JSON array");

  return body.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`entry ${i} is not an object`);
    const record: Record<string, unknown> = { ...entry };
    const { name, kind, ref } = record;
    if (typeof name !== "string" || typeof ref !== "string") {
      throw new Error(`entry ${i} needs string name and ref`);
    }
    if (kind !== "github" && kind !== "rss") {
      throw new Error(`entry ${i} has kind ${String(kind)}; expected github or rss`);
    }
    const homepage = typeof record["homepage"] === "string" ? record["homepage"] : null;
    return { name, kind, ref, homepage };
  });
}

async function main(): Promise<void> {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) {
    console.error("usage: bun scripts/seed-roster.ts <roster.json> [--backfill]");
    process.exit(2);
  }

  const roster = parseRoster(await Bun.file(path).text());
  const store = new Store(DB_PATH);

  // upsertApp is idempotent on kind+ref, so re-running is safe and picks up
  // roster edits rather than duplicating the whole list.
  for (const entry of roster) store.upsertApp(entry);
  console.log(`[seed] ${roster.length} apps into ${DB_PATH}`);

  if (flags.includes("--backfill")) {
    console.log(`[seed] backfilling last ${BACKFILL_DEPTH} per app…`);
    const summary = await poll(store, undefined, { backfill: true });
    console.log(
      `[seed] backfill: ${summary.inserted} rows, ${summary.failed.length} apps failed`,
    );
    for (const failure of summary.failed) console.error(`  ${failure.app}: ${failure.error}`);
  }

  console.log("[seed]", JSON.stringify(store.counts()));
  store.close();
}

if (import.meta.main) {
  await main();
}
