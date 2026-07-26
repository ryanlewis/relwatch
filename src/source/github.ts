// GitHub Releases source — 36 of the 38 roster feeds (DESIGN §1).
//
// Unauthenticated to start: 38 calls per 6-hourly cycle sits under the 60/hr
// anonymous limit, and conditional requests that come back 304 don't count
// against it at all. A fine-grained read-only PAT at RW_GITHUB_TOKEN_FILE drops
// in without a code change if that ever bites.
import { readFileSync } from "node:fs";
import { GITHUB_PER_PAGE, GITHUB_TOKEN_FILE, SOURCE_TIMEOUT_MS, USER_AGENT } from "../config.js";
import {
  clampNotes,
  normaliseDate,
  SourceError,
  type FetchOptions,
  type FetchResult,
  type FetchedRelease,
  type Source,
} from "./index.js";

/** The subset of GitHub's release object we use. */
interface GitHubRelease {
  id?: number;
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string | null;
}

/**
 * Read the PAT if one exists. Cached after the first read including the "no
 * token" answer, so a poll cycle isn't 38 stat() calls on a file that is
 * normally absent.
 */
let tokenCache: { value: string | null } | null = null;

export function readGitHubToken(): string | null {
  if (tokenCache) return tokenCache.value;
  let value: string | null = null;
  try {
    const raw = readFileSync(GITHUB_TOKEN_FILE, "utf8").trim();
    value = raw.length > 0 ? raw : null;
  } catch {
    value = null; // absent is the normal, documented state
  }
  tokenCache = { value };
  return value;
}

/** Tests only — drops the memoised token so a fixture can change it. */
export function resetGitHubTokenCache(): void {
  tokenCache = null;
}

/** `owner/repo`, tolerating a full GitHub URL or a releases.atom feed URL. */
export function parseRepoRef(ref: string): string {
  const trimmed = ref.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, "");
  const withoutSuffix = trimmed
    .replace(/\/releases\.atom$/i, "")
    .replace(/\/releases\/?$/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = withoutSuffix.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new SourceError(`not an owner/repo reference: ${ref}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

export class GitHubSource implements Source {
  readonly kind = "github" as const;

  constructor(private readonly apiBase = "https://api.github.com") {}

  async fetch(ref: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const repo = parseRepoRef(ref);
    const perPage = opts.limit ?? GITHUB_PER_PAGE;
    const url = `${this.apiBase}/repos/${repo}/releases?per_page=${perPage}`;

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    const token = readGitHubToken();
    if (token) headers["authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      headers,
      signal: opts.signal ?? AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });

    // The steady state: nothing changed, and this one is free.
    if (res.status === 304) {
      return { releases: [], etag: opts.etag ?? null, notModified: true };
    }
    if (!res.ok) {
      // GitHub signals an exhausted quota as 403 (or 429) with the remaining
      // count at zero — not as a distinct status. Without reading the header
      // it is indistinguishable from "this repo is private".
      const remaining = res.headers.get("x-ratelimit-remaining");
      const rateLimited =
        (res.status === 403 || res.status === 429) && (remaining === "0" || remaining === null);

      if (rateLimited) {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetsAt = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
        throw new SourceError(
          `GitHub rate limit exhausted (resets ${resetsAt})`,
          res.status,
          true,
        );
      }
      throw new SourceError(`GitHub ${res.status} for ${repo}`, res.status);
    }

    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new SourceError(`GitHub returned a non-array body for ${repo}`, res.status);
    }

    const releases = body
      .filter((r): r is GitHubRelease => typeof r === "object" && r !== null)
      // Drafts are unpublished by definition; prereleases are real releases and
      // stay in — triage is what decides whether an RC matters.
      .filter((r) => r.draft !== true)
      .map((r) => toFetched(r, repo))
      .filter((r): r is FetchedRelease => r !== null);

    return { releases, etag: res.headers.get("etag"), notModified: false };
  }
}

function toFetched(r: GitHubRelease, repo: string): FetchedRelease | null {
  // ext_id is the release id — deliberately not the tag, which repos re-point.
  // Without an id there's nothing stable to dedupe on, so fall back to the tag
  // rather than inventing one and risking a duplicate every cycle.
  const extId = r.id !== undefined ? String(r.id) : (r.tag_name ?? null);
  if (!extId) return null;

  const tag = r.tag_name ?? null;
  return {
    ext_id: extId,
    tag,
    // Plenty of releases have an empty name; the tag is the better title then.
    title: r.name?.trim() ? r.name.trim() : tag,
    url: r.html_url ?? (tag ? `https://github.com/${repo}/releases/tag/${tag}` : null),
    notes: clampNotes(r.body),
    published_at: normaliseDate(r.published_at ?? r.created_at),
  };
}
