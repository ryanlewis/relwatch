// Vercel AI SDK provider (DESIGN §4.4). Two tiers, one interface.
//
// The tiers need genuinely different call shapes, which is the whole reason the
// seam exists: the ChatGPT-subscription tier is Responses-API-only and requires
// store:false *and* stream:true, so it must go through streamObject; the
// Anthropic tier is a plain generateObject. Same schema, same return type.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, NoObjectGeneratedError, streamObject } from "ai";
import {
  ANTHROPIC_BASE,
  ANTHROPIC_MODEL,
  BACKEND,
  OPENAI_BASE,
  OPENAI_MODEL,
  type Backend,
} from "../config.js";
import { ProviderError, type Provider } from "./index.js";
import {
  buildPrompt,
  buildRepairPrompt,
  SYSTEM_PROMPT,
  TriageSchema,
  type ReleaseInput,
  type Triage,
} from "./schema.js";

/**
 * One generation attempt. Returns the parsed object, or throws — the caller
 * turns a throw into the repair retry.
 */
export type Generate = (prompt: string, signal: AbortSignal) => Promise<Triage>;

export class AiSdkProvider implements Provider {
  readonly name: string;
  private readonly generate: Generate;

  /**
   * `generate` is injectable so the validate/repair path — the part with real
   * branching, and the part most likely to be wrong — can be exercised without
   * a live model behind internal-only DNS. Production always takes the default.
   */
  constructor(backend: Backend = BACKEND, generate?: Generate) {
    if (backend === "anthropic") {
      this.name = `anthropic:${ANTHROPIC_MODEL}`;
      this.generate = generate ?? anthropicGenerate;
    } else {
      this.name = `openai-responses:${OPENAI_MODEL}`;
      this.generate = generate ?? openaiGenerate;
    }
  }

  /**
   * Validate/repair (DESIGN §4.3). The SDK enforces the schema on the wire, but
   * adherence is a property of the model rather than the provider — a model
   * that answers in prose fails identically on both wire shapes — so a failed
   * parse gets exactly one repair attempt with its own output fed back.
   */
  async triage(release: ReleaseInput, signal: AbortSignal): Promise<Triage> {
    try {
      return await this.generate(buildPrompt(release), signal);
    } catch (err) {
      if (!isRepairable(err)) throw asProviderError(err);

      const raw = NoObjectGeneratedError.isInstance(err) ? (err.text ?? "") : "";
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[triage] repairing unusable output for ${release.app}: ${reason}`);

      try {
        return await this.generate(buildRepairPrompt(release, raw, reason), signal);
      } catch (repairErr) {
        // Second failure: the caller records triage_error and the release
        // renders untriaged. It is never dropped.
        throw asProviderError(repairErr);
      }
    }
  }
}

const openai = createOpenAI({
  baseURL: OPENAI_BASE,
  // The exe.dev integration authenticates the VM itself; the SDK still insists
  // on a non-empty key, so this placeholder is what "no keys on disk" looks like.
  apiKey: "unused",
});

const anthropic = createAnthropic({
  baseURL: ANTHROPIC_BASE,
  apiKey: "unused",
});

const openaiGenerate: Generate = async (prompt, abortSignal) => {
  const stream = streamObject({
    model: openai.responses(OPENAI_MODEL),
    schema: TriageSchema,
    system: SYSTEM_PROMPT,
    prompt,
    abortSignal,
    // store:false is mandatory on this tier, and streaming is why it must be
    // streamObject rather than generateObject. max_output_tokens is rejected
    // outright, so it is deliberately not set anywhere.
    providerOptions: { openai: { store: false } },
  });

  // The stream MUST be drained before awaiting `.object`.
  //
  // `streamObject` is lazy: nothing is pulled from the underlying response
  // until something consumes it, so `await stream.object` on its own never
  // settles. Verified against the live gateway — draining first yields the
  // object in ~6 s, while awaiting `.object` alone sat there until the 90 s
  // abort fired and then failed. Every triage call would have done that.
  //
  // (DESIGN §4.4's sample shows the bare `await s.object`; it is wrong.)
  // Partials are discarded deliberately — the dashboard has no use for a
  // half-formed triage; draining is the point.
  for await (const partial of stream.partialObjectStream) void partial;

  return await stream.object;
};

const anthropicGenerate: Generate = async (prompt, abortSignal) => {
  const { object } = await generateObject({
    model: anthropic(ANTHROPIC_MODEL),
    schema: TriageSchema,
    system: SYSTEM_PROMPT,
    prompt,
    abortSignal,
  });
  return object;
};

/**
 * A repairable failure is one where the model answered but the answer didn't
 * fit the schema. A transport failure, a 429 or a timeout is not repairable by
 * re-prompting — the retry/backoff layer above owns those.
 */
export function isRepairable(err: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(err)) return true;
  // Zod validation surfacing through the SDK under a few names depending on
  // where in the pipeline it failed.
  if (err instanceof Error) {
    return /TypeValidationError|JSONParseError|did not match schema/i.test(
      `${err.name} ${err.message}`,
    );
  }
  return false;
}

/** Normalise an SDK error into one carrying an HTTP status, for the retry policy. */
export function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const status = extractStatus(err);
  const wrapped = new ProviderError(message, status);
  if (err instanceof Error) wrapped.stack = err.stack;
  return wrapped;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record: Record<string, unknown> = { ...err };
  for (const key of ["statusCode", "status"]) {
    const value = record[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}
