import type { AssistantLlmHostManager } from '@brainstrike/assistant-service/ports';
import { z } from 'zod';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const ScriptSchema = z.strictObject({ text: z.string().min(1) });

/**
 * An isolated E2E launch's stand-in for the hidden llm-host renderer's
 * generation, so a host thread can select the built-in local model without
 * downloading it. Read only when the launch is in E2E test mode and supplies
 * BRAINSTRIKE_E2E_LLM_HOST_SCRIPT (`{"text": ...}`); a shipped launch never
 * reads it. Everything up to Main's manager seam stays real.
 */
export function createE2eScriptedLlmHost(): AssistantLlmHostManager | undefined {
  if (!isElectronE2ETestMode()) {
    return;
  }
  const raw = process.env['BRAINSTRIKE_E2E_LLM_HOST_SCRIPT'];
  if (!raw) {
    return;
  }
  const { text } = ScriptSchema.parse(JSON.parse(raw));
  return {
    generateForMain: async (_payload, options) => {
      options.signal?.throwIfAborted();
      options.onProgress?.({ kind: 'text', text });
      return {
        finishReason: 'stop',
        text,
        usage: { completionTokens: 8, promptTokens: 24, totalTokens: 32 },
      };
    },
    warmupForMain: async (_modelId, options) => {
      options.signal?.throwIfAborted();
    },
  };
}
