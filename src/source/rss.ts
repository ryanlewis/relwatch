// RSS/Atom source — the two roster stragglers (Forgejo via Codeberg, Obsidian's
// changelog.xml) that the GitHub API doesn't cover.
//
// Both Atom and RSS 2.0 are handled: they name everything differently, so each
// field is read through a small list of aliases rather than a per-format parser.
import { XMLParser } from "fast-xml-parser";
import { SOURCE_TIMEOUT_MS, USER_AGENT } from "../config.js";
import {
  clampNotes,
  normaliseDate,
  SourceError,
  type FetchOptions,
  type FetchResult,
  type FetchedRelease,
  type Source,
} from "./index.js";

// Attributes are kept (Atom's <link href="…"> carries the URL in one) and text
// is left unparsed, so a tag like "1.10" never becomes the number 1.1.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function isNode(v: unknown): v is XmlNode {
  return typeof v === "object" && v !== null;
}

/** A repeated element parses to an array, a lone one doesn't. Normalise. */
function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Flatten a node to text. Handles the three shapes fast-xml-parser produces:
 * a bare string, `{ "#text": … }` for an element with attributes, and Atom's
 * `{ "@_type": "html", "#text": … }` content elements.
 */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (isNode(v)) return text(v["#text"]);
  return null;
}

/** First non-null value among several possible element names. */
function pick(node: XmlNode, ...keys: string[]): unknown {
  for (const k of keys) {
    if (node[k] !== undefined && node[k] !== null) return node[k];
  }
  return undefined;
}

/**
 * Extract a link. Atom puts it in `href`, preferring rel="alternate"; RSS puts
 * it in the element text.
 */
function linkOf(node: XmlNode): string | null {
  const raw = pick(node, "link");
  for (const candidate of asArray(raw)) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (isNode(candidate)) {
      const rel = candidate["@_rel"];
      const href = candidate["@_href"];
      if (typeof href === "string" && href.trim() && (rel === undefined || rel === "alternate")) {
        return href.trim();
      }
    }
  }
  // Fall back to any href at all, even a rel we skipped above.
  for (const candidate of asArray(raw)) {
    if (isNode(candidate)) {
      const href = candidate["@_href"];
      if (typeof href === "string") return href.trim() || null;
    }
  }
  return null;
}

export class RssSource implements Source {
  readonly kind = "rss" as const;

  async fetch(ref: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const headers: Record<string, string> = {
      accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "user-agent": USER_AGENT,
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;

    const res = await fetch(ref, {
      headers,
      signal: opts.signal ?? AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });

    if (res.status === 304) {
      return { releases: [], etag: opts.etag ?? null, notModified: true };
    }
    if (!res.ok) throw new SourceError(`feed ${res.status} for ${ref}`, res.status);

    const releases = parseFeed(await res.text(), ref);
    const limited = opts.limit === undefined ? releases : releases.slice(0, opts.limit);
    return { releases: limited, etag: res.headers.get("etag"), notModified: false };
  }
}

/** Exported for tests: parse a feed body into releases, newest first. */
export function parseFeed(xml: string, ref: string): FetchedRelease[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new SourceError(`unparseable feed at ${ref}: ${String(err)}`);
  }
  if (!isNode(doc)) throw new SourceError(`empty feed at ${ref}`);

  // Atom: <feed><entry>. RSS: <rss><channel><item>, or a bare <channel>.
  const feed = isNode(doc["feed"]) ? doc["feed"] : null;
  const rss = isNode(doc["rss"]) ? doc["rss"] : null;
  const channelRaw = (rss ?? doc)["channel"];
  const channel = isNode(channelRaw) ? channelRaw : null;

  const rawItems = feed ? asArray(feed["entry"]) : channel ? asArray(channel["item"]) : [];
  if (!feed && !channel) throw new SourceError(`not an RSS or Atom feed: ${ref}`);

  const items = rawItems.filter(isNode).map(toFetched).filter(isFetched);

  // Feeds are conventionally newest-first but not required to be. Sort so
  // backfill's "last N" takes the newest N, not whatever happened to be on top.
  return items.toSorted((a, b) => {
    if (a.published_at === b.published_at) return 0;
    if (a.published_at === null) return 1;
    if (b.published_at === null) return -1;
    return a.published_at < b.published_at ? 1 : -1;
  });
}

function isFetched(r: FetchedRelease | null): r is FetchedRelease {
  return r !== null;
}

function toFetched(item: XmlNode): FetchedRelease | null {
  const link = linkOf(item);
  // guid/id is the stable identifier; the link is the only fallback that stays
  // constant across re-fetches. A title would change when upstream edits it.
  const extId = text(pick(item, "guid", "id")) ?? link;
  if (!extId) return null;

  const title = text(pick(item, "title"));
  const published = normaliseDate(
    text(pick(item, "published", "pubDate", "updated", "dc:date")),
  );
  const notes = clampNotes(
    text(pick(item, "content", "content:encoded", "description", "summary")),
  );

  return {
    ext_id: extId,
    // Feeds have no tag field; the title is the version string in practice
    // ("v1.2.3", "Forgejo v13.0.1"), which is what the dashboard shows.
    tag: title,
    title,
    url: link,
    notes,
    published_at: published,
  };
}
