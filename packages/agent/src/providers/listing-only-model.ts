import type { LanguageModel } from '@mastra/core/llm';

const LISTING_ONLY_INVARIANT =
  'listing-only runtime: model must never be invoked (suspended-run discovery performs no inference)';

/**
 * An inert `LanguageModelV2`-shaped stub for the suspended-run DISCOVERY path.
 *
 * Its live consumer is the host's hosted tool discovery
 * (`agent-host/src/adapters/host-tool-discovery.ts`), which needs a model-shaped
 * value to feed the tool-search processor but never runs inference. It was
 * introduced for the retired engine's suspended-run DISCOVERY path, where
 * `listSuspendedRuns()` only read workflow-storage snapshots yet the runtime
 * unconditionally instantiated a language model. Resolving a real provider/model for listing is
 * wasteful, and a provider whose model cannot be resolved throws at init, before any listing
 * happens. This stub lets the listing runtime build with
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
