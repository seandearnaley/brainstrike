/**
 * Visible copy for a provider finish that did not complete the response.
 * Shared by the legacy data-stream mapper and the CLI-first host, so both
 * paths tell the user the same truth about the same finish reason.
 */
import {
  findLlmModelDefinition,
  type OpenAiReasoningEffort,
  type ProviderId,
} from '@brainstrike/assistant-contract';
import type { RuntimeData, StreamFinishReason } from '../types';

export interface OutputLimitContext {
  readonly model?: string;
  readonly provider?: ProviderId;
  readonly reasoningEffort?: OpenAiReasoningEffort;
}

const GENERIC_OUTPUT_LIMIT_MESSAGE =
  'Assistant stopped because the model reached its output token limit before completing the response.';
const KIMI_K3_OPENROUTER_MODEL_ID = 'moonshotai/kimi-k3';

/** The run's selection, as the output-limit copy needs it. */
export function outputLimitContextFor(
  runtimeData: Pick<RuntimeData, 'model' | 'provider' | 'requestedReasoningEffort'> | undefined
): OutputLimitContext | undefined {
  const reasoningEffort = runtimeData?.requestedReasoningEffort;
  return runtimeData?.provider === 'openrouter' &&
    typeof runtimeData.model === 'string' &&
    typeof reasoningEffort === 'string'
    ? { model: runtimeData.model, provider: 'openrouter', reasoningEffort }
    : undefined;
}

export function getAbnormalFinishMessage(
  reason: StreamFinishReason,
  outputLimitContext?: OutputLimitContext
): string | undefined {
  switch (reason) {
    case 'length':
      return getKimiK3OutputLimitMessage(outputLimitContext) ?? GENERIC_OUTPUT_LIMIT_MESSAGE;
    case 'content-filter':
      return 'Assistant stopped because the provider content filter ended the response.';
    case 'other':
      return 'Assistant stream ended without a normal stop signal.';
    case 'unrecognized':
      return 'Assistant stream ended with an unrecognized finish reason.';
    case 'absent':
    case 'stop':
    case 'tool-calls':
    case 'error':
    case 'unknown':
      return;
    default:
      return;
  }
}

/** A finish that would complete a turn the model contributed nothing to. */
export function describeEmptyModelResponse(
  model: string | undefined,
  finishReason: string
): string {
  return (
    `The model${model ? ` "${model}"` : ''} returned an empty response — no text, reasoning, ` +
    `or tool calls (finish reason "${finishReason}"). The provider route may be ` +
    'degraded; retry, or switch models.'
  );
}

function getKimiK3OutputLimitMessage(context?: OutputLimitContext): string | undefined {
  if (
    context?.provider !== 'openrouter' ||
    context.model !== KIMI_K3_OPENROUTER_MODEL_ID ||
    (context.reasoningEffort !== 'high' && context.reasoningEffort !== 'max')
  ) {
    return;
  }
  const model = findLlmModelDefinition('openrouter', context.model);
  if (!model?.reasoning?.supportedEfforts?.includes('low')) {
    return;
  }
  const modelLabel = model.label?.replace(/\s+\(OpenRouter\)$/u, '') ?? 'Kimi K3';
  return `Assistant stopped because ${modelLabel} reached its output token limit before completing the response. Retry with reasoning effort set to Low or Auto.`;
}
