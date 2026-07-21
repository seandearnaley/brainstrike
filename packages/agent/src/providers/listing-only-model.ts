import type { LanguageModel } from '@mastra/core/llm';

const LISTING_ONLY_INVARIANT =
  'listing-only runtime: model must never be invoked (suspended-run discovery performs no inference)';

/**
 * An inert `LanguageModelV2`-shaped stub for the suspended-run DISCOVERY path.
 *
 * `agent.listSuspendedRuns()` only reads workflow-storage snapshots — it never
 * runs inference — yet `createMastraAgentRuntime` unconditionally instantiates a
 * language model. Resolving a real provider/model for listing is both wasteful
 * and a live failure mode: a keyless provider with no static default (e.g.
 * `ollama`, whose models are discovered dynamically) throws
 * `No default model configured` at init, before any listing happens (the D1
 * `/assistant/suspended-runs` 500). This stub lets the listing runtime build with
 * NO provider/model resolution at all. Every generation method THROWS so a
 * regression that accidentally routes inference here fails loudly instead of
 * silently degrading (no-silent-fallbacks).
 */
export function createListingOnlyModel(): LanguageModel {
  const fail = (): never => {
    throw new Error(LISTING_ONLY_INVARIANT);
  };
  return {
    doGenerate: fail,
    doStream: fail,
    modelId: 'brainstrike-listing-only',
    provider: 'brainstrike-listing-only',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}
