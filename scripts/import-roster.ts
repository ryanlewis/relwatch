#!/usr/bin/env bun
// One-off: Miniflux category 6 ("Releases") → roster.json (DESIGN §6.1).
//
// Runs on the laptop, where the Miniflux token already lives, and writes a
// plain JSON file. The VM seeds from that file rather than reaching Miniflux
// itself — which keeps the VM's secrets at exactly one Hubbub key (PLAN D3).
//
//   bun scripts/import-roster.ts > roster.json
//
// Env:
//   MF_URL     Miniflux base (default https://miniflux.example.com)
//   MF_CAT     category id (default 6)
//   MF_TOKEN_FILE  API token path (default ~/.config/relwatch/miniflux-token)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppKind } from "../src/db.js";
import { parseRepoRef } from "../src/source/github.js";
import { deriveAppName } from "../src/source/index.js";

interface MinifluxFeed {
  title?: string;
  feed_url?: string;
  site_url?: string;
}

export interface RosterEntry {
  name: string;
  kind: AppKind;
  ref: string;
  homepage: string | null;
}

const MF_URL = process.env["MF_URL"] ?? "https://miniflux.example.com";
const MF_CAT = process.env["MF_CAT"] ?? "6";
const TOKEN_FILE =
  process.env["MF_TOKEN_FILE"] ?? join(homedir(), ".config/relwatch/miniflux-token");

/**
 * Miniflux titles GitHub feeds "Release notes from uv"; the roster wants "uv".
 *
 * GitHub names are derived from the ref rather than the title, so they follow
 * the same rule as an app added through the dashboard — including the generic
 * repo-name case that would otherwise make `cli/cli` and `httpie/cli` both
 * "cli". Feeds keep their own title, which is usually the better label
 * ("Obsidian Changelog" beats "obsidian.md").
 */
export function cleanName(title: string | undefined, kind: AppKind, ref: string): string {
  if (kind === "github") return deriveAppName(kind, ref);

  const stripped = title
    ?.replace(/^Release notes from\s+/i, "")
    .replace(/^Releases for\s+/i, "")
    .trim();
  return stripped || deriveAppName(kind, ref);
}

/** A GitHub releases.atom URL becomes a `github` app; everything else is `rss`. */
export function classify(feedUrl: string): { kind: AppKind; ref: string } {
  if (/^https?:\/\/(www\.)?github\.com\//i.test(feedUrl)) {
    return { kind: "github", ref: parseRepoRef(feedUrl) };
  }
  return { kind: "rss", ref: feedUrl };
}

export function toRoster(feeds: readonly MinifluxFeed[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();

  for (const feed of feeds) {
    if (!feed.feed_url) continue;
    try {
      const { kind, ref } = classify(feed.feed_url);
      const key = `${kind}:${ref}`;
      if (seen.has(key)) continue; // two feeds pointing at one repo
      seen.add(key);

      entries.push({
        name: cleanName(feed.title, kind, ref),
        kind,
        ref,
        homepage: feed.site_url ?? null,
      });
    } catch (err) {
      // A feed we can't classify is reported, never silently dropped.
      console.error(`[import] skipping ${feed.feed_url}: ${String(err)}`);
    }
  }

  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error(`empty Miniflux token at ${TOKEN_FILE}`);

  const res = await fetch(`${MF_URL}/v1/categories/${MF_CAT}/feeds`, {
    headers: { "x-auth-token": token },
  });
  if (!res.ok) throw new Error(`Miniflux ${res.status} listing category ${MF_CAT}`);

  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Miniflux returned a non-array feed list");

  const roster = toRoster(body.filter((f): f is MinifluxFeed => typeof f === "object" && f !== null));
  const github = roster.filter((r) => r.kind === "github").length;
  console.error(`[import] ${roster.length} apps (${github} github, ${roster.length - github} rss)`);

  console.log(JSON.stringify(roster, null, 2));
}

if (import.meta.main) {
  await main();
}
