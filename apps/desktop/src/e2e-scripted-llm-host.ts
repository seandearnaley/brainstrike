import type { AssistantLlmHostManager } from '@brainstrike/assistant-service/ports';
import { z } from 'zod';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';
import { broadcastLoadingProgressToVisibleWindows } from './llm-host-manager';
import type { LlmHostProgressPayload } from './llm-host-shared';

const ScriptSchema = z.strictObject({
  /** Report a cold model load on warmup, as the hidden renderer does. */
  loading: z.literal(true).optional(),
  text: z.string().min(1),
});

/** One loading report, forwarded and broadcast the way the manager does for Main's loads. */
function reportLoading(
  payload: LlmHostProgressPayload,
  onProgress: ((progress: LlmHostProgressPayload) => void) | undefined
): void {
  onProgress?.(payload);
  broadcastLoadingProgressToVisibleWindows({
    channel: 'llm-progress',
    payload,
    requestId: 'main:e2e-scripted-warmup',
    runtimeId: 'llm-host:e2e-scripted',
    type: 'progress',
  });
}

/**
 * An isolated E2E launch's stand-in for the hidden llm-host renderer's
 * generation, so a host thread can select the built-in local model without
 * downloading it. Read only when the launch is in E2E test mode and supplies
 * BRAINSTRIKE_E2E_LLM_HOST_SCRIPT (`{"text": ..., "loading"?: true}`); a
 * shipped launch never reads it. Everything up to Main's manager seam stays
 * real, including the loading broadcast to visible windows.
 */
export function createE2eScriptedLlmHost(): AssistantLlmHostManager | undefined {
  if (!isElectronE2ETestMode()) {
    return;
  }
  const raw = process.env['BRAINSTRIKE_E2E_LLM_HOST_SCRIPT'];
  if (!raw) {
    return;
  }
  const script = ScriptSchema.parse(JSON.parse(raw));
  return {
    generateForMain: async (_payload, options) => {
      options.signal?.throwIfAborted();
      options.onProgress?.({ kind: 'text', text: script.text });
      return {
        finishReason: 'stop',
        text: script.text,
        usage: { completionTokens: 8, promptTokens: 24, totalTokens: 32 },
      };
    },
    warmupForMain: async (_modelId, options) => {
      options.signal?.throwIfAborted();
      if (script.loading) {
        reportLoading(
          { kind: 'loading', message: 'Loading model files', progress: 50 },
          options.onProgress
        );
        reportLoading({ kind: 'loading', message: 'Model loaded', progress: 100 }, undefined);
      }
    },
  };
}
