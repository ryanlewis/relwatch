// Deterministic provider for offline work — local dev without the internal DNS,
// and tests of everything downstream of triage (digest rendering, the dashboard's
// badges) that would otherwise need a live model.
//
// It is not a mock in the test-double sense: the heuristics are crude but real,
// so `RW_BACKEND=stub bun src/index.ts` on a laptop gives a plausibly-populated
// dashboard rather than a wall of identical rows.
import type { Provider } from "./index.js";
import type { ReleaseInput, Triage } from "./schema.js";

const BREAKING = /\bbreaking\b|\bmigrat(e|ion)\b|\bremoved\b|\bno longer\b|\bincompatible\b/i;
const MAJOR = /\bmajor\b|\brewrite\b|\bintroduc(e|ing)\b|\bnew\b.{0,20}\b(feature|api|support)\b/i;
const MAINTENANCE = /\b(bug ?fix|patch|chore|bump|dependen|typo|revert)\b/i;

export class StubProvider implements Provider {
  readonly name = "stub";

  triage(release: ReleaseInput): Promise<Triage> {
    const text = `${release.tag ?? ""} ${release.title ?? ""} ${release.notes ?? ""}`;
    const major = isMajorVersion(release.tag) || MAJOR.test(text);
    const maintenance = MAINTENANCE.test(text);

    return Promise.resolve({
      verdict: major ? "major" : maintenance ? "maintenance" : "interesting",
      summary: `${release.app} ${release.tag ?? "release"} — offline triage stub.`,
      breaking: BREAKING.test(text),
      highlights: bullets(release.notes),
    });
  }
}

/** A `.0.0` tag is the one version signal worth reading without a model. */
function isMajorVersion(tag: string | null): boolean {
  return tag !== null && /^v?\d+\.0\.0$/.test(tag.trim());
}

/** First few list items from the notes, if they look like a changelog. */
function bullets(notes: string | null): string[] {
  if (!notes) return [];
  return notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .slice(0, 3)
    .map((line) => line.replace(/^[-*]\s+/, "").slice(0, 120));
}
