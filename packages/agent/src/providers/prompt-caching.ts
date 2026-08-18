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
 * NO SILENT FALLBACK, in both directions: an undeclared route is sent no
 * breakpoints at all (never a guessed dialect), and a declared dialect this
 * build has no wrapper for throws rather than degrading to "uncached".
 */
import { createMastraAgentError } from '../mastra/mastra-agent-error';
import { wrapAnthropicModelWithPromptCaching } from './anthropic-prompt-caching';
import { wrapBedrockModelWithPromptCaching } from './bedrock-prompt-caching';
import { findLlmModelDefinition, type SupportedProvider } from './types';

/**
 * Wrap `model` with the caching wrapper its registry entry declares.
 *
 * @param provider - Registry provider id the model was built from.
 * @param modelId - CATALOG model id (unprefixed). Bedrock applies cross-region
 *   inference-profile prefixes per request; the registry is keyed on the
 *   unprefixed id, so callers must pass the id they looked the model up by,
 *   not the routed one.
 * @returns The wrapped model, or `model` unchanged when the route declares no
 *   prompt-caching dialect.
 */
export function wrapModelWithDeclaredPromptCaching<M extends object>(
  provider: SupportedProvider,
  modelId: string,
  model: M
): M {
  const promptCaching = findLlmModelDefinition(provider, modelId)?.promptCaching;
  switch (promptCaching) {
    case 'anthropic':
      return wrapAnthropicModelWithPromptCaching(model);
    case 'bedrock':
      return wrapBedrockModelWithPromptCaching(model);
    case undefined:
      // Uncatalogued ids land here too: a model this build has no capability
      // record for is sent no breakpoints, rather than being assumed to speak
      // its provider's dialect.
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
