import { createHash } from 'node:crypto';
import {
  APPROX_CHARS_PER_TOKEN,
  decodedTextModelOutputChars,
  type ToolProjectionRewriteEntry,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, type NativeToolId } from '@brainstrike/assistant-contract';
import { stableNormalizedArgsKey } from './tool-call-loop-guards';

/** Newest estimated tool-result tokens that recency pruning must preserve. */
export const TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS = 40_000;

/** Minimum estimated token saving required before a prune batch is committed. */
export const TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS = 20_000;

const TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_CHARS =
  TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;
const TOOL_PROJECTION_PRUNE_MIN_RECLAIM_CHARS =
  TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS * APPROX_CHARS_PER_TOKEN;
const ARGS_DIGEST_HEX_CHARS = 12;

const SKILL_ACTIVATION_TOOL_IDS: ReadonlySet<NativeToolId> = new Set([
  NATIVE_TOOL_ID.skill,
  NATIVE_TOOL_ID.skillRead,
  NATIVE_TOOL_ID.skillSearch,
]);

export interface RecencyPruneInvocation {
  readonly args: Record<string, unknown>;
  readonly modelOutput: unknown;
  readonly toolCallId: string;
  readonly toolName: NativeToolId;
}

export type RecencyPruneCandidate = Extract<ToolProjectionRewriteEntry, { kind: 'prune' }> & {
  readonly originalChars: number;
  readonly reclaimableChars: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function decodedContentModelOutputChars(value: readonly unknown[]): number {
  let chars = 0;
  for (const part of value) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      chars += decodedTextModelOutputChars(part['text']);
    }
  }
  return chars;
}

/** Measure the exact persisted model-facing text projection with the shared ruler. */
export function decodedPersistedModelOutputChars(modelOutput: unknown): number {
  if (!isRecord(modelOutput)) {
    throw new TypeError('Persisted native-tool model output must be an object.');
  }
  if (modelOutput['type'] === 'text' && typeof modelOutput['value'] === 'string') {
    return decodedTextModelOutputChars(modelOutput['value']);
  }
  if (modelOutput['type'] === 'content' && Array.isArray(modelOutput['value'])) {
    return decodedContentModelOutputChars(modelOutput['value']);
  }
  throw new TypeError('Persisted native-tool model output must be text or content shaped.');
}

function shortArgsDigest(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableNormalizedArgsKey(args))
    .digest('hex')
    .slice(0, ARGS_DIGEST_HEX_CHARS);
}

/** Generic, single-line replay marker for every recency-prunable native tool. */
export function buildRecencyPruneMarker(
  toolName: NativeToolId,
  args: Record<string, unknown>
): string {
  return `[pruned old tool result — tool=${toolName} args=${shortArgsDigest(args)}; re-run the tool to obtain it again]`;
}

/**
 * Select one deterministic oldest-first batch. Every invocation that overlaps
 * the newest protect window is protected in full; results are never split.
 * Current-turn ids remain in the size walk (they are part of the newest
 * context) but are independently ineligible at every age.
 */
export function selectRecencyPruneCandidates(args: {
  readonly currentTurnToolCallIds: ReadonlySet<string>;
  readonly invocations: readonly RecencyPruneInvocation[];
}): RecencyPruneCandidate[] {
  const invocationIndexByToolCallId = new Map<string, number>();
  const invocations: RecencyPruneInvocation[] = [];
  for (const invocation of args.invocations) {
    const priorIndex = invocationIndexByToolCallId.get(invocation.toolCallId);
    if (priorIndex === undefined) {
      invocationIndexByToolCallId.set(invocation.toolCallId, invocations.length);
      invocations.push(invocation);
    } else {
      invocations[priorIndex] = invocation;
    }
  }
  const originalChars = invocations.map((invocation) =>
    decodedPersistedModelOutputChars(invocation.modelOutput)
  );
  const protectedIndexes = new Set<number>();
  let protectedChars = 0;
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (protectedChars >= TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_CHARS) {
      break;
    }
    protectedIndexes.add(index);
    protectedChars += originalChars[index] ?? 0;
  }

  const candidates: RecencyPruneCandidate[] = [];
  for (let index = 0; index < invocations.length; index += 1) {
    const invocation = invocations[index];
    const invocationChars = originalChars[index];
    if (!(invocation && invocationChars !== undefined)) {
      continue;
    }
    if (
      protectedIndexes.has(index) ||
      args.currentTurnToolCallIds.has(invocation.toolCallId) ||
      SKILL_ACTIVATION_TOOL_IDS.has(invocation.toolName)
    ) {
      continue;
    }
    const markerText = buildRecencyPruneMarker(invocation.toolName, invocation.args);
    const reclaimableChars = Math.max(0, invocationChars - decodedTextModelOutputChars(markerText));
    candidates.push({
      kind: 'prune',
      markerText,
      originalChars: invocationChars,
      reclaimableChars,
      supersededByToolCallId: null,
      toolCallId: invocation.toolCallId,
    });
  }

  const reclaimableChars = candidates.reduce(
    (total, candidate) => total + candidate.reclaimableChars,
    0
  );
  return reclaimableChars >= TOOL_PROJECTION_PRUNE_MIN_RECLAIM_CHARS ? candidates : [];
}
