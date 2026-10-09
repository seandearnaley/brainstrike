import type { ToolProjectionRewriteEntry } from '@brainstrike/agent';
import type {
  HostProjectionRewrite,
  HostProjectionRewriteRequest,
  HostToolInvocation,
} from '@brainstrike/agent-host';
import { denormalizeNativeToolName, isNativeToolId } from '@brainstrike/assistant-contract';
import {
  type RecencyPruneInvocation,
  selectRecencyPruneCandidates,
} from './tool-projection-prune.js';
import {
  collectSupersessionCandidates,
  type PersistedToolInvocation,
  TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS,
} from './tool-projection-supersession.js';

const PROJECTED_OUTPUT_TYPES: ReadonlySet<unknown> = new Set(['content', 'json', 'text']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * A committed call as legacy rewriting read a persisted native invocation:
 * catalog tool name, object input and a successful text/content/json projection.
 */
function nativeInvocation(invocation: HostToolInvocation): PersistedToolInvocation | undefined {
  const toolName = denormalizeNativeToolName(invocation.toolName);
  if (
    !(
      isNativeToolId(toolName) &&
      isRecord(invocation.args) &&
      isRecord(invocation.modelOutput) &&
      PROJECTED_OUTPUT_TYPES.has(invocation.modelOutput['type'])
    )
  ) {
    return;
  }
  return {
    args: invocation.args,
    modelOutput: invocation.modelOutput,
    result: invocation.output,
    toolCallId: invocation.toolCallId,
    toolName,
  };
}

/** The committed entry only; candidate sizes stay with the policy. */
function entry(candidate: ToolProjectionRewriteEntry): HostProjectionRewrite {
  const { markerText, toolCallId } = candidate;
  return candidate.kind === 'prune'
    ? { kind: 'prune', markerText, supersededByToolCallId: null, toolCallId }
    : {
        kind: 'supersession',
        markerText,
        supersededByToolCallId: candidate.supersededByToolCallId,
        toolCallId,
      };
}

/**
 * The host's rewrite policy port, in the legacy order: stale-read
 * supersession first, committed only past its 64 KiB batch threshold, then
 * recency pruning of what supersession did not take.
 */
export function selectHostProjectionRewrites(
  request: HostProjectionRewriteRequest
): HostProjectionRewrite[] {
  const invocations = request.invocations.flatMap((invocation) => {
    const native = nativeInvocation(invocation);
    return native ? [native] : [];
  });
  const superseded = collectSupersessionCandidates({ invocations });
  const reclaimable = superseded.reduce(
    (total, candidate) => total + candidate.reclaimableChars,
    0
  );
  const supersessions =
    reclaimable >= TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS ? superseded : [];
  const taken = new Set(supersessions.map((candidate) => candidate.toolCallId));
  const prunable: RecencyPruneInvocation[] = invocations.flatMap(
    ({ args, modelOutput, toolCallId, toolName }) =>
      taken.has(toolCallId) || !isNativeToolId(toolName)
        ? []
        : [{ args, modelOutput, toolCallId, toolName }]
  );
  const pruned = selectRecencyPruneCandidates({
    currentTurnToolCallIds: request.currentTurnToolCallIds,
    invocations: prunable,
  });
  return [...supersessions, ...pruned].map(entry);
}
