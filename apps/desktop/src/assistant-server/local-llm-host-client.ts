/**
 * Main-process implementation of the agent package's `LocalLlmHostClient`:
 * proxies built-in local LLM generation from the assistant server (Electron
 * main) to the hidden llm-host renderer via `LlmHostManager`.
 *
 * This is the injection seam that lets provider 'local' run inside the real
 * Mastra loop (memory, run events, tool guards) while Gemma inference stays
 * renderer-only per the LOCAL LLM ARCHITECTURE rules.
 */
import type { LocalLlmHostClient } from '@brainstrike/agent/local-llm';
import type { LlmHostManager } from '../llm-host-manager';

export type AssistantLlmHostManager = Pick<LlmHostManager, 'generateForMain' | 'warmupForMain'>;

export function createMainLlmHostClient(manager: AssistantLlmHostManager): LocalLlmHostClient {
  return {
    generate: (request, options = {}) =>
      manager.generateForMain(
        {
          messages: request.messages,
          modelId: request.modelId,
          ...(request.options ? { options: request.options } : {}),
        },
        options
      ),
    warmup: (modelId, options = {}) => manager.warmupForMain(modelId, options),
  };
}
