import { createHash } from 'node:crypto';
import {
  APPROX_CHARS_PER_TOKEN,
  decodedTextModelOutputChars,
  type ToolProjectionRewriteEntry,
  toJsonSafe,
} from '@brainstrike/agent';
import type { HostProjectionRewrite, HostProjectionRewriteRequest } from '@brainstrike/agent-host';
import {
  denormalizeNativeToolName,
  isNativeToolId,
  type NativeToolId,
  RECENCY_PRUNABLE_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { stableNormalizedArgsKey } from './tool-call-loop-guards.js';

/** Newest estimated tool-result tokens that recency pruning must preserve. */
export const TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS = 40_000;

/** Minimum estimated token saving required before a prune batch is committed. */
export const TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS = 20_000;

const TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_CHARS =
  TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;
const TOOL_PROJECTION_PRUNE_MIN_RECLAIM_CHARS =
  TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS * APPROX_CHARS_PER_TOKEN;
const ARGS_DIGEST_HEX_CHARS = 12;

/**
 * Recency pruning previously treated every `NativeToolId` except the three
 * skill activations as eligible, so its generic "re-run the tool to obtain
 * it again" marker was also emitted for mutating/interactive tools —
 * `writeWorkspaceFile`, `deleteWorkspaceFile`, `executeCommand`, `runPython`,
 * `askUser`, `manageCanvas`, `manageTaskList`, `manageCommandSession`,
 * `submitPlan`, `runSkillScript`, and more (BST-1200 review). Re-running one
 * of those is either not idempotent (a mutation repeats), not free
 * (persists more app state), or not what the marker implies (`askUser`/
 * `submitPlan` suspend for a NEW answer, not a replay of the old one). Their
 * projections are also tiny (a path, an exit code), so the reclaim from
 * pruning them is near zero while the downside is a plausible repeated
 * mutation.
 *
 * An explicit ALLOWLIST of genuinely read-only, cheap-to-re-run tools (never
 * a denylist) keeps every new/future native tool exempt by default. This is
 * a NARROWER, purpose-specific set than `tool-risk.ts`'s `'read'` risk
 * bucket: `askUser`/`submitPlan`/`manageTaskList`/`manageCanvas` resolve to
 * `'read'` there (no workspace/fs mutation requiring approval) but stay
 * exempt here for the reasons above — do not conflate the two lists, and do
 * not derive this set from `resolveToolRiskCategory`. Membership is declared
 * per tool (`history.recencyPrunable` on its `defineNativeTool` definition)
 * and derived here.
 *
 * `skill` and `skill_read` stay exempt (their output IS the working skill
 * body a later turn may still need — never prune it). `skill_search`
 * differs: like `grepSearch`, its output is a disposable search-result list,
 * cheap and idempotent to reproduce, so it is listed here instead of being
 * unconditionally exempt.
 */
const READ_ONLY_PRUNABLE_TOOL_IDS: ReadonlySet<NativeToolId> = new Set(
  RECENCY_PRUNABLE_NATIVE_TOOL_IDS
);

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

/**
 * `type: 'json'` is a legitimate persisted projection shape, not malformed
 * data: `tool-output-artifact-reader.ts`'s `buildModelPage()` (for
 * `readToolOutputArtifact`) and `tool-output-artifact-settlement.ts`'s
 * `createArtifactOutputs()` (for ANY tool whose output spilled to an
 * artifact — precisely the largest, most pruning-worthy results) both
 * produce it, and `tool-model-output.ts` normalizes/preserves it end to end.
 * Measure it the same way that file's own `stringifyJsonSafe` does: through
 * the shared `toJsonSafe` serializer, then the decoded-text ruler.
 */
function decodedJsonModelOutputChars(value: unknown): number {
  const serialized = JSON.stringify(toJsonSafe(value));
  if (serialized === undefined) {
    throw new TypeError('Persisted native-tool json model output could not be serialized.');
  }
  return decodedTextModelOutputChars(serialized);
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
  if (modelOutput['type'] === 'json' && Object.hasOwn(modelOutput, 'value')) {
    return decodedJsonModelOutputChars(modelOutput['value']);
  }
  throw new TypeError('Persisted native-tool model output must be text, content, or json shaped.');
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
      !READ_ONLY_PRUNABLE_TOOL_IDS.has(invocation.toolName)
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

const PROJECTED_OUTPUT_TYPES: ReadonlySet<unknown> = new Set(['content', 'json', 'text']);

/**
 * The host's rewrite policy port: legacy recency pruning over a branch's
 * committed native-tool invocations. A call counts only with object input
 * and a successful text/content/json projection, as legacy persisted ones.
 */
export function selectHostProjectionRewrites(
  request: HostProjectionRewriteRequest
): HostProjectionRewrite[] {
  const invocations: RecencyPruneInvocation[] = [];
  for (const invocation of request.invocations) {
    const toolName = denormalizeNativeToolName(invocation.toolName);
    if (
      isNativeToolId(toolName) &&
      isRecord(invocation.args) &&
      isRecord(invocation.modelOutput) &&
      PROJECTED_OUTPUT_TYPES.has(invocation.modelOutput['type'])
    ) {
      invocations.push({
        args: invocation.args,
        modelOutput: invocation.modelOutput,
        toolCallId: invocation.toolCallId,
        toolName,
      });
    }
  }
  return selectRecencyPruneCandidates({
    currentTurnToolCallIds: request.currentTurnToolCallIds,
    invocations,
  }).map(({ kind, markerText, supersededByToolCallId, toolCallId }) => ({
    kind,
    markerText,
    supersededByToolCallId,
    toolCallId,
  }));
}
