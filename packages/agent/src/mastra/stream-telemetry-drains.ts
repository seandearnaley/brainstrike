/**
 * Per-attempt telemetry drains (BST-1649 split from `agent-streaming.ts`):
 * queued delegation-usage chunks, the missing-finish synthetic ending, the
 * terminal stream-outcome/token-diagnostics logs, and the once-per-attempt
 * tool-call-telemetry / token-estimate-calibration chunks.
 *
 * All six are called from ONE place — `streamAttemptChunks` in
 * `agent-streaming.ts`, which stays there as the real stream-consumption
 * core. Nothing in `turn-attempts.ts` calls these directly.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import { createLogger } from '@brainstrike/logging';
import type { RuntimeData, StreamChunk } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import { makeSyntheticFinishChunk } from '../tool-projection/stream-run-event-chunks';
import type { DelegationUsageCapture, ToolLifecycleState } from './tool-lifecycle-processors';
import { makePendingToolOutputRunEventChunks } from './tool-lifecycle-processors';

const logger = createLogger('MastraAgent');

/** Yield the queued child-usage chunks for this leg's delegation capture, if any. */
export function* drainDelegationUsageChunks(
  capture: DelegationUsageCapture | undefined,
  part?: unknown
): Generator<StreamChunk> {
  if (!capture) {
    return;
  }
  yield* capture.drain(part);
}

/** Post-loop chunks when a stream ends WITHOUT a finish event (not aborted). */
export function makeMissingFinishStreamChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  logger.warn('mastra stream ended without finish event', {
    code: 'mastra_agent_stream_missing_finish',
  });
  return [...makePendingToolOutputRunEventChunks(lifecycleState), makeSyntheticFinishChunk()];
}

export function logStreamOutcome(aborted: boolean): void {
  if (aborted) {
    logger.info('mastra stream aborted', { code: 'mastra_agent_stream_aborted' });
    return;
  }
  logger.info('mastra stream finished', { code: 'mastra_agent_stream_finished' });
}

export function logTokenDiagnostics(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  lifecycleState: ToolLifecycleState
): void {
  const fields = runtime.tokenDiagnostics.toLogFields({
    ...(lifecycleState.providerReportedPromptTokens === undefined
      ? {}
      : { promptTokensSummedAcrossSteps: lifecycleState.providerReportedPromptTokens }),
    ...(lifecycleState.latestStepPromptTokens === undefined
      ? {}
      : { latestStepPromptTokens: lifecycleState.latestStepPromptTokens }),
    stepCount: lifecycleState.stepCount,
  });
  const context = {
    code: 'mastra_agent_token_measurement',
    ...(runtimeData?.model ? { model: runtimeData.model } : {}),
    ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
    ...fields,
  };
  if (fields['measurementStatus'] === 'failed') {
    logger.warn(context, 'mastra run token measurement failed visibly');
    return;
  }
  logger.info(context, 'mastra run token measurement recorded');
}

export function* drainToolCallTelemetryChunks(
  terminal: boolean,
  runtime: MastraAgentRuntime,
  state: { emitted: boolean }
): Generator<StreamChunk> {
  if (!(terminal && !state.emitted)) {
    return;
  }
  state.emitted = true;
  const value = runtime.tokenDiagnostics.toolCallTelemetry();
  if (value.length > 0) {
    yield { type: 'tool-call-telemetry', value };
  }
}

/**
 * Emit one completed-run pair on the final-prompt-content basis. The numerator
 * counts model-visible tool-output projections plus tool definitions once; the
 * denominator is the latest step prompt, which contains every prior tool
 * output once through Mastra's resend behavior—not the cross-step billing sum.
 * Conversation/system-prompt text outside tool outputs and definitions is
 * excluded from both, and a run without a measured tool output is ineligible.
 */
export function* drainTokenEstimateCalibrationChunk(
  terminal: boolean,
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  lifecycleState: ToolLifecycleState,
  state: { emitted: boolean },
  promptBreakdown: AssistantContextBreakdown | undefined
): Generator<StreamChunk> {
  if (!(terminal && !state.emitted)) {
    return;
  }
  state.emitted = true;
  const finalStepPromptTokens = lifecycleState.latestStepPromptTokens;
  const model = runtimeData?.model;
  const provider = runtimeData?.provider;
  if (finalStepPromptTokens === undefined || !(model && provider)) {
    return;
  }
  const fields = runtime.tokenDiagnostics.toLogFields();
  if (fields['measurementStatus'] === 'failed') {
    return;
  }
  const modelVisibleProjectionCount = fields['modelVisibleProjectionCount'] as number;
  // BST-1232 review (P1): a run with zero measured tool-output projections
  // used to be entirely ineligible for this chunk, which meant an ordinary
  // tool-free chat turn NEVER persisted `promptBreakdownBaselineTokens` —
  // silently starving the next turn's compaction trigger of the one value
  // this migration exists to give it. The estimator-vs-provider RATIO this
  // chunk also carries (estimatedPromptTokens/finalStepPromptTokens) is
  // still only meaningful when real tool-output measurement happened
  // (BST-1205); that eligibility gate belongs to the reader
  // (`model_visible_projection_count > 0`), not the writer, so a
  // zero-projection row can be written here without resurrecting a
  // meaningless ratio sample downstream. A row is
  // still skipped only when there is NOTHING new to report: no measured
  // tool output AND no prompt breakdown to source a baseline from.
  if (modelVisibleProjectionCount === 0 && !promptBreakdown) {
    return;
  }
  // Comparable final-prompt basis: the numerator counts model-visible tool
  // outputs and tool definitions once; the latest step prompt already contains
  // every prior tool output once via Mastra's resend behavior. Conversation and
  // system-prompt text outside those shares remain excluded from both figures.
  const estimatedPromptTokens =
    (fields['modelVisibleProjectionBackstopTokens'] as number) +
    ((fields['toolDefinitionBackstopTokens'] as number | undefined) ?? 0);
  yield {
    type: 'token-estimate-calibration',
    value: {
      estimatedPromptTokens,
      finalStepPromptTokens,
      model,
      modelVisibleProjectionCount,
      occurredAt: Date.now(),
      provider,
      // BST-1232 review: `taskListTokens` absent genuinely means "no task
      // list" (0 is honest), but `toolDefinitionsTokens` absent means tool-
      // definition measurement FAILED for this run (see
      // `RunTokenDiagnostics.toolDefinitionContextBreakdown()`'s own "absent,
      // never zero-faked" contract) — folding that to 0 would silently
      // understate the baseline by roughly the whole tool catalog
      // (~9.8k tokens) while looking like valid evidence to the next turn's
      // trigger. Omit the field entirely rather than persist a fabricated
      // partial sum (no-silent-fallbacks); migration 091's NULL already
      // means exactly "no trustworthy baseline for this row".
      ...(promptBreakdown && promptBreakdown.toolDefinitionsTokens !== undefined
        ? {
            promptBreakdownBaselineTokens:
              promptBreakdown.systemInstructionsTokens +
              (promptBreakdown.taskListTokens ?? 0) +
              promptBreakdown.toolDefinitionsTokens,
          }
        : {}),
      resolvedDomainBudgetTokens: runtime.resolvedToolResultBudget.domainModelResultTokens,
      resolvedTransportBudgetTokens: runtime.resolvedToolResultBudget.transportResultTokens,
      stepCount: lifecycleState.stepCount,
    },
  };
}
