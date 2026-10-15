/**
 * Prompt-caching wrapper SELECTION (BST-1354).
 *
 * Before this module the provider factory chose a caching wrapper by PROVIDER
 * ID: hosted Anthropic got one, everything else got none. That cannot express
 * Bedrock, whose catalog is heterogeneous — Claude and Nova accept Converse
 * `cachePoint` checkpoints, Llama and DeepSeek accept none — and the obvious
 * repair (matching `anthropic.` or `nova` in the model id) is exactly the
 * substring-sniffing this codebase forbids.
 *
 * So the REGISTRY decides. `LlmModelDefinition.promptCaching` names the cache
 * dialect a route accepts, and this function is the only translation from that
 * declaration to a wrapper. Adding a Bedrock model therefore means declaring
 * what it supports, not editing a factory switch.
 *
 * NOTHING here degrades quietly. A declared dialect this build has no wrapper
 * for THROWS. An id that misses the catalog cannot throw — it was legal before
 * this ticket and hosted Anthropic accepted any model name — so it WARNS, with
 * the id and a typed code, and ships uncached. And a Bedrock id carrying a
 * cross-region routing prefix RESOLVES to its catalog row instead of missing
 * it, so region routing never costs a route its caching or reasoning.
 */
import { createLogger } from '@brainstrike/logging';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { wrapAnthropicModelWithPromptCaching } from './anthropic-prompt-caching';
import { stripCrossRegionPrefix } from './bedrock-model-id';
import { wrapBedrockModelWithPromptCaching } from './bedrock-prompt-caching';
import { findLlmModelDefinition, type LlmModelDefinition, type SupportedProvider } from './types';

const logger = createLogger('PromptCaching');

/**
 * Resolve a model's declared capabilities from a Bedrock or first-party id.
 *
 * Bedrock stores ids UNPREFIXED and applies the cross-region inference-profile
 * prefix per request — but `createProvider` also accepts an already-prefixed id
 * and passes it through (the BST-1350 contract, pinned by
 * provider-factory.bedrock.spec.ts). A routed id therefore genuinely reaches
 * this lookup, and a raw registry miss would cost that route BOTH prompt
 * caching and its reasoning dialect while looking indistinguishable from an
 * uncatalogued model.
 *
 * So the prefix is RESOLVED away rather than rejected: it selects a region, it
 * never changes what the model supports. An id that still misses after
 * stripping is genuinely uncatalogued and is reported as such by the caller.
 */
export function findModelCapabilities(
  provider: SupportedProvider,
  modelId: string
): LlmModelDefinition | undefined {
  const catalogId = provider === 'bedrock' ? stripCrossRegionPrefix(modelId) : modelId;
  return findLlmModelDefinition(provider, catalogId);
}

/**
 * Wrap `model` with the caching wrapper its registry entry declares.
 *
 * @param provider - Registry provider id the model was built from.
 * @param modelId - CATALOG model id (unprefixed for Bedrock — see
 *   `findModelCapabilities`).
 * @returns The wrapped model, or `model` unchanged when the route declares no
 *   prompt-caching dialect.
 */
export function wrapModelWithDeclaredPromptCaching<M extends object>(
  provider: SupportedProvider,
  modelId: string,
  model: M
): M {
  const definition = findModelCapabilities(provider, modelId);
  if (!definition) {
    // Not a throw: an uncatalogued id is reachable from persisted preferences
    // and from any provider that accepts arbitrary model names, and it worked
    // before this ticket. It ships uncached — but never silently, because the
    // only symptom otherwise is a bill.
    logger.warn(
      { code: 'prompt_caching_model_not_catalogued', model: modelId, provider },
      'Model is absent from the static registry; sending no prompt-cache breakpoints for it'
    );
    return model;
  }
  const promptCaching = definition.promptCaching;
  switch (promptCaching) {
    case 'anthropic':
      return wrapAnthropicModelWithPromptCaching(model);
    case 'bedrock':
      return wrapBedrockModelWithPromptCaching(model);
    case undefined:
      // A catalogued route that declares no dialect genuinely supports none.
      return model;
    default: {
      const exhausted: never = promptCaching;
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { model: modelId, promptCaching: String(exhausted), provider },
        detail: `No prompt-caching wrapper is implemented for dialect: ${String(exhausted)}`,
      });
    }
  }
}
