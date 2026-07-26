// The triage schema — single source of truth (DESIGN §4.3). Both providers
// enforce it on the wire, and the validate/repair path re-checks it, because
// schema adherence is a property of the *model*, not the provider: glm-5p2
// returned prose on both wire shapes during the spike.
import { z } from "zod";

export const TriageSchema = z.object({
  verdict: z.enum(["major", "interesting", "maintenance"]),
  /** One-line flavour, as the shell script produced today. */
  summary: z.string(),
  breaking: z.boolean(),
  /** Up to 3 — the dashboard has room for them, the email lists them under major. */
  highlights: z.array(z.string()).max(3),
});

export type Triage = z.infer<typeof TriageSchema>;

/** What triage is shown about a release. */
export interface ReleaseInput {
  app: string;
  tag: string | null;
  title: string | null;
  notes: string | null;
  url: string | null;
}

export const SYSTEM_PROMPT = [
  "You triage software release notes for a developer's personal release tracker.",
  "Classify each release and describe it factually. No marketing language, no",
  "preamble, no markdown.",
  "",
  "verdict:",
  '  "major"       — a headline release: significant new capability, a major',
  "                  version bump, or anything the reader would want to act on.",
  '  "interesting" — worth a look: notable features, meaningful improvements.',
  '  "maintenance" — routine: bug fixes, dependency bumps, chores, patch',
  "                  releases with nothing user-facing.",
  "",
  "summary: one sentence, under 25 words, describing what changed. Write it as",
  "a statement about the release, not about the notes.",
  "",
  "breaking: true only when the notes actually indicate a breaking change,",
  "a required migration, or a removed/renamed interface. A major version bump",
  "alone is not enough.",
  "",
  "highlights: up to 3 short bullets naming specific changes. Fewer is fine;",
  "an empty array is correct for a routine patch. Never pad to three.",
].join("\n");

/** The user-side prompt for one release. */
export function buildPrompt(input: ReleaseInput): string {
  return [
    `Project: ${input.app}`,
    `Release: ${input.tag ?? input.title ?? "(untitled)"}`,
    input.title && input.title !== input.tag ? `Title: ${input.title}` : "",
    "",
    "RELEASE NOTES:",
    '"""',
    input.notes?.trim() || "(no release notes provided)",
    '"""',
    "",
    "Triage this release.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The repair prompt: hand the model back its own unusable output and the
 * validation error. One retry only — a model that fails twice is failing
 * structurally, and a third call just spends time we've capped anyway.
 */
export function buildRepairPrompt(input: ReleaseInput, raw: string, error: string): string {
  return [
    buildPrompt(input),
    "",
    "Your previous response could not be used.",
    `Validation error: ${error}`,
    "Previous response:",
    '"""',
    raw.slice(0, 2_000),
    '"""',
    "",
    "Respond again, conforming exactly to the required schema.",
  ].join("\n");
}
