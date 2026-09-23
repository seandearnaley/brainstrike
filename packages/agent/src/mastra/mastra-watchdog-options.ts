/**
 * The Mastra-specific classifiers `withInactivityTimeout` runs over a raw
 * Mastra stream (docs/agents/assistant-runtime.md, "Stream inactivity
 * watchdog"): part naming for the stall breadcrumb, the closed scaffolding
 * list, the reasoning and tool-execution part kinds, the delegation envelope
 * reader, and the background-leg part router. A leaf module: no runtime or
 * stream-mapper imports, so every watchdog over Mastra parts shares it.
 */
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import { formatDiagnosticChunkType } from '../stream/diagnostic-chunk-type';
import type { StreamInactivityOptions, StreamPartRoute } from '../stream/with-inactivity-timeout';
import type { StreamChunk } from '../types';
import type { StaticMastraChunkType } from './agent-streaming';
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';

/**
 * Name a raw Mastra part for the stall diagnostic. Knowing WHAT the provider
 * last sent before going quiet (`reasoning-delta` vs `tool-call-delta` vs
 * `step-start`) is the difference between diagnosing a stall from a debug
 * bundle and reconstructing it by inference (BST-1408).
 */
export function describeMastraStreamPartType(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) {
    return;
  }
  const type = (part as { type?: unknown }).type;
  // Bounded through the shared diagnostic formatter: the value is provider
  // data, and a stall breadcrumb must not carry an unbounded string.
  return typeof type === 'string' ? formatDiagnosticChunkType(type) : undefined;
}

/**
 * Mastra part types the FRAMEWORK emits at stream/step open, before the
 * provider is asked for anything.
 *
 * Measured through the real loop (review of #2586): `start` lands at t+0ms and
 * `step-start` ~7ms later, while the provider's first real part follows
 * hundreds of milliseconds afterwards — and a fresh `step-start` opens every
 * subsequent step too. Counting these as "the provider started" would end the
 * wide first-output window within milliseconds and measure every real
 * time-to-first-token against the tight inter-output one, which is precisely
 * the failure this split exists to prevent.
 *
 * Deliberately a CLOSED list of scaffolding rather than an allowlist of output
 * kinds: a Mastra release that adds a new provider part type must default to
 * "this is output" (tightening the window on a part we know arrived from the
 * provider), never to "this is free" (silently widening it forever).
 */
const MASTRA_SCAFFOLDING_PART_TYPES: ReadonlySet<string> = new Set(['start', 'step-start']);

/** @internal exported for tests */
export function isMastraProviderOutputPart(part: unknown): boolean {
  const type = describeMastraStreamPartType(part);
  return type === undefined || !MASTRA_SCAFFOLDING_PART_TYPES.has(type);
}

/**
 * Mastra part types that carry REASONING rather than an answer.
 *
 * These are unambiguously provider output — they must never be mistaken for
 * framework scaffolding — but they are the model THINKING, so the silence
 * around them is measured against the wide reasoning window instead of the
 * tight inter-output one (see `StreamStallPhase` in
 * ../stream/with-inactivity-timeout.ts).
 *
 * CONTENT vs MARKER is load-bearing. A thinking delta ENTERS the reasoning
 * phase; block bookkeeping only PRESERVES the phase already in effect.
 * Providers exist that emit `text-start` BEFORE `reasoning-end`, so treating
 * the end marker as content would widen the window back out exactly as the
 * answer began. Preserving keeps a not-yet-answering stream wide (the gap
 * between `reasoning-end` and the first `text-delta` is still "has it begun
 * answering?") and an already-answering stream tight.
 *
 * Typed as `StaticMastraChunkType`, the union DERIVED FROM MASTRA'S OWN
 * `ChunkType['type']` that `MASTRA_STATIC_CHUNK_DISPOSITIONS` is checked
 * against. A Mastra release that renames one of these fails to compile here
 * rather than silently dropping a type out of the set and re-arming the tight
 * window against high-effort reasoning — the exact regression this prevents.
 */
const MASTRA_REASONING_PART_KINDS = {
  'reasoning-delta': 'content',
  'reasoning-end': 'marker',
  'reasoning-signature': 'marker',
  'reasoning-start': 'content',
  'redacted-reasoning': 'content',
} as const satisfies Partial<Record<StaticMastraChunkType, 'content' | 'marker'>>;

export function readMastraReasoningPartKind(part: unknown): 'content' | 'marker' | undefined {
  const type = describeMastraStreamPartType(part);
  if (type === undefined || !Object.hasOwn(MASTRA_REASONING_PART_KINDS, type)) {
    return;
  }
  return MASTRA_REASONING_PART_KINDS[type as keyof typeof MASTRA_REASONING_PART_KINDS];
}

/**
 * Mastra part types that START or SETTLE one tool execution (BST-1777).
 *
 * Pinned against the compiled @mastra/core 1.64.0 loop: `tool-execution-start`
 * / `tool-execution-end` look like the obvious boundary but are emitted only
 * `from: "NETWORK"` (agent networks) and never reach this stream. The agent
 * loop's boundary is `tool-call` -> `tool-result` | `tool-error`.
 *
 * `tool-call-approval` and `tool-call-suspended` SETTLE: the call is waiting
 * on a human, not executing, and a human wait must never inherit the wide
 * tool-executing backstop. `tool-output-denied` is the declined outcome.
 *
 * Typed against `StaticMastraChunkType` for the same reason the reasoning map
 * is: a Mastra rename fails to compile here instead of silently dropping a
 * boundary and leaving a running tool on the tight window.
 */
const MASTRA_TOOL_EXECUTION_PART_KINDS = {
  'tool-call': 'started',
  'tool-call-approval': 'settled',
  'tool-call-suspended': 'settled',
  'tool-error': 'settled',
  'tool-output-denied': 'settled',
  'tool-result': 'settled',
} as const satisfies Partial<Record<StaticMastraChunkType, 'started' | 'settled'>>;

/**
 * Whether a tool call has a per-call execution guard behind it (BST-1777
 * final re-review, I2-C). `tool-executing`'s wide window is only safe to
 * enter because a guard ALWAYS fires first and turns a wedge into a bounded,
 * recoverable failure — `isRecoverableStall` treating this phase as terminal
 * (never resumed) is only honest under that premise, since the guard's own
 * window is what makes a `tool-executing` stall attributable to a still-live
 * tool call rather than a broken guard. `isRecoverableStall` itself attaches
 * no user-facing message; the backstop text that reports the stall lives in
 * `stream-termination.ts`.
 *
 * This is deliberately an ALLOW-list, not a deny-list: `guardedToolNames` is
 * exactly the key set of `runtime.toolNameMap`, which is populated (in
 * `tool-pipeline.ts`, `sanitizeTools` + `collectCombinedTools`) BEFORE
 * `applyToolGuards` runs over `combinedTools`, and nothing is added to it
 * afterwards for a tool that skipped the guard. So membership in this set IS
 * "went through `applyToolGuards`" — an unknown or future-unguarded tool name
 * defaults to `false` and stays on the tight window, per the file's own
 * closed-list rule (unknown -> tighten), rather than requiring every new
 * unguarded kind to be named here as it is discovered. Three kinds are
 * deliberately never in the set and therefore always ride the ordinary
 * provider-silence windows instead of `tool-executing`:
 *
 * - Provider-executed tools (native web search): injected AFTER
 *   `sanitizeTools`/`applyToolGuards` (see `../providers/native-web-search.ts`),
 *   so Mastra marks the part `payload.providerExecuted === true` — kept as an
 *   explicit check because that entry REPLACES a sanitized local name that IS
 *   still a key in `toolNameMap`, so a name match alone is not enough.
 * - Subagent delegation tools (`agent-<personaId>`): the parent registers them
 *   directly on `new Agent({ agents: subAgents })` (`agent-runtime.ts`), never
 *   through `combinedTools`/`sanitizeTools`, so they are never a key in
 *   `toolNameMap` and the allow-list already excludes them.
 * - Mastra-injected memory tools (`updateWorkingMemory`, `setWorkingMemory`,
 *   `recall` — see `internal-approval-exempt-tools.ts`): Mastra merges these
 *   into the run's tool map itself, after this pipeline runs, so they too are
 *   never a key in `toolNameMap`.
 *
 * A call this returns `false` for must NOT enter `tool-executing`: it keeps
 * riding the ordinary provider-silence windows it always has, so a wedge
 * there is diagnosed (and, where recoverable, retried) honestly instead of
 * being reported as a broken guard that was never there.
 */
export function hasExecutionGuardBehindToolCall(
  toolName: string | undefined,
  providerExecuted: unknown,
  guardedToolNames: ReadonlySet<string>
): boolean {
  return providerExecuted !== true && toolName !== undefined && guardedToolNames.has(toolName);
}

/**
 * The part type a FOREGROUND delegation wraps every child chunk in on the
 * PARENT stream, and the deepest nesting the classifier will unwrap.
 *
 * Shape (see `resolveChildDelegation` in `delegated-stream-projection.ts`,
 * which is the production reader of exactly this envelope):
 *
 *     { type: 'tool-output',
 *       runId: <parent run id>,
 *       payload: { output: <the child's own Mastra part>,
 *                  toolCallId, toolName: 'agent-<personaId>' } }
 *
 * A grandchild arrives as an envelope inside an envelope, so the unwrap
 * recurses — bounded, because `output` is ultimately provider/tool data and an
 * unbounded walk over it is not something a watchdog may do. The bound is one
 * past `DELEGATION_LIMITS.maxDepth`'s reach in practice; a structure deeper
 * than this yields `undefined`, which TIGHTENS (the call rides the ordinary
 * provider windows) rather than widening.
 */
const MASTRA_DELEGATED_CHILD_ENVELOPE_TYPE = 'tool-output';
const MAX_DELEGATED_ENVELOPE_UNWRAPS = 8;

/**
 * The child part a delegation envelope carries, or `undefined` when `part` is
 * not one. POSITIVE identification (see the reader below): a `tool-output`
 * whose `toolName` is delegation-prefixed and not `providerExecuted`.
 * Wrapped so an envelope carrying no part is still told apart from a
 * non-envelope.
 */
export function unwrapDelegatedChildPart(part: unknown): { readonly child: unknown } | undefined {
  if (describeMastraStreamPartType(part) !== MASTRA_DELEGATED_CHILD_ENVELOPE_TYPE) {
    return;
  }
  const toolName = readMastraStreamPartString(part, 'toolName');
  if (
    toolName === undefined ||
    !toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX) ||
    readMastraStreamPartValue(part, 'providerExecuted') === true
  ) {
    return;
  }
  return { child: readMastraStreamPartValue(part, 'output') };
}

/**
 * The innermost part under nested delegation envelopes (a grandchild's inside
 * its child's), or `undefined` at a `tool-output` that is not a delegation
 * envelope or past {@link MAX_DELEGATED_ENVELOPE_UNWRAPS} — both TIGHTEN.
 */
function unwrapDelegatedChain(part: unknown): { readonly part: unknown } | undefined {
  let current = part;
  for (
    let depth = 0;
    describeMastraStreamPartType(current) === MASTRA_DELEGATED_CHILD_ENVELOPE_TYPE;
    depth += 1
  ) {
    const envelope =
      depth < MAX_DELEGATED_ENVELOPE_UNWRAPS ? unwrapDelegatedChildPart(current) : undefined;
    if (!envelope) {
      return;
    }
    current = envelope.child;
  }
  return { part: current };
}

/**
 * Builds the `toolExecutionPartKind` classifier for one leg, closed over that
 * leg's guarded-name allow-list (`runtime.toolNameMap`'s keys). A factory
 * rather than a bare function because the classifier is already constructed
 * per leg (see `resolveMastraInactivityOptions`) and the guarded set is
 * per-runtime, not global.
 *
 * DELEGATED CHILD CALLS (BST-1777 PR review, Codex P1). Mastra carries a
 * foreground child's parts INSIDE the parent delegation's `tool-output`
 * envelope; the child has no watchdog of its own, and the parent's delegation
 * `tool-call` is deliberately NOT guarded (the allow-list excludes
 * `agent-<personaId>`), so classifying only the outer part left a child's
 * guarded execution measured against the parent's `streaming` window. Before
 * this ticket the flat 60s guard kept that under the window; now a child
 * command may legitimately run to its own 600s budget, so the envelope must be
 * unwrapped. Children select their tools from the parent's ALREADY-GUARDED map
 * by sanitized id (`build-persona-subagents.ts`, `selectCandidateTools` over
 * `params.guardedTools`), so a child's tool name is a key of the same
 * `toolNameMap` and the allow-list applies unchanged.
 *
 * POSITIVE IDENTIFICATION, not "not guarded" (CodeRabbit MAJOR, round 2): the
 * envelope is unwrapped ONLY when its `toolName` starts with
 * `SUBAGENT_DELEGATION_TOOL_PREFIX` ('agent-') AND it is not itself
 * `providerExecuted`. "Not in the guarded set" is a deny-list in disguise — it
 * also matches provider-executed tool outputs and Mastra-injected memory-tool
 * outputs (`updateWorkingMemory`, `recall`, …), neither of which is a
 * delegation envelope, and either one's `output` could then be misread as a
 * nested guarded `tool-call`. Grandchildren are also `agent-<personaId>`
 * envelopes, so the bounded recursion below still reaches them.
 *
 * Two consequences, both deliberate:
 * - The in-flight set is keyed by tool-call id alone, so a child id colliding
 *   with a parent id makes a nested `settled` release the parent's entry
 *   early. That tightens into a RECOVERABLE phase, not a consequence-free one
 *   (round 2, Claude F): the still-running parent call drops back onto the
 *   provider windows, where a stall is classified `streaming`, and a
 *   `streaming` stall IS recoverable — so `runTurnAttempts` can re-send the
 *   step while the parent tool may still be alive, exactly the second-execution
 *   hazard `isRecoverableStall` refuses `tool-executing` for. Collision
 *   probability across parent and child runs is negligible with
 *   provider-generated ids, so the keying is unchanged — but if it ever needs
 *   to be, the envelope already carries the child `runId` that
 *   `resolveChildDelegation` reads, so a `runId:toolCallId` key is available.
 * - A child's nested `step-start` does NOT reach the generic
 *   scaffolding-clear: the OUTER part is `tool-output`, which counts as
 *   provider output (`MASTRA_SCAFFOLDING_PART_TYPES` is the closed set
 *   `{start, step-start}`). So a lost nested `settled` is not cleared by the
 *   child's own step boundary — it is cleared at the PARENT's next
 *   `step-start`, which is the same bound every other in-flight id has.
 *
 * @internal exported for tests
 */
export function createMastraToolExecutionPartKindReader(
  guardedToolNames: ReadonlySet<string>
): (part: unknown) => { kind: 'started' | 'settled'; toolCallId: string } | undefined {
  return (rawPart: unknown) => {
    const innermost = unwrapDelegatedChain(rawPart);
    if (!innermost) {
      return;
    }
    const { part } = innermost;
    const type = describeMastraStreamPartType(part);
    if (type === undefined || !Object.hasOwn(MASTRA_TOOL_EXECUTION_PART_KINDS, type)) {
      return;
    }
    const payload = (part as { payload?: unknown }).payload;
    const toolCallId =
      typeof payload === 'object' && payload !== null
        ? (payload as { toolCallId?: unknown }).toolCallId
        : undefined;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return;
    }
    const kind =
      MASTRA_TOOL_EXECUTION_PART_KINDS[type as keyof typeof MASTRA_TOOL_EXECUTION_PART_KINDS];
    if (kind === 'started') {
      const toolName = readMastraStreamPartString(part, 'toolName');
      const providerExecuted = readMastraStreamPartValue(part, 'providerExecuted');
      if (!hasExecutionGuardBehindToolCall(toolName, providerExecuted, guardedToolNames)) {
        return;
      }
    }
    return { kind, toolCallId };
  };
}

/**
 * What each native background event does to the parent's HOLD on its task.
 * These are bookkeeping, never the parent's output. `started` — the dispatch
 * acknowledgement on the parent's OWN turn — holds the stream open for the
 * task, queued or not; a terminal or a suspension releases it (a human wait
 * holds nothing); only `resumed` holds a released task again. `running` holds
 * nothing: the manager re-tells it to every new subscriber and publishes it
 * for work this stream never dispatched, and an orphan must not widen the
 * parent's own window. `output` is the child's own part: its liveness is its
 * own watchdog's (`background-child-watchdog.ts`), so to the parent it is
 * activity only.
 *
 * Typed like the maps above, so a Mastra rename fails to compile. A lifecycle
 * type missing here falls through to ordinary output, which tightens.
 */
const MASTRA_BACKGROUND_HOLD_EFFECTS = {
  'background-task-cancelled': 'releases',
  'background-task-completed': 'releases',
  'background-task-failed': 'releases',
  'background-task-output': 'none',
  'background-task-progress': 'none',
  'background-task-resumed': 'holds-again',
  'background-task-running': 'none',
  'background-task-started': 'holds',
  'background-task-suspended': 'releases',
} as const satisfies Partial<
  Record<StaticMastraChunkType, 'holds' | 'holds-again' | 'none' | 'releases'>
>;

/**
 * Host rows the background loop writes into a leg's stream (the durable
 * ledger's `delegation.ledger` event, a live decision's answer). They are the
 * host's bookkeeping, not a producer's output: counted as output, a ledger row
 * landing during the parent's first-output wait tightened it to `streaming`.
 */
const HOST_BOOKKEEPING_PART_TYPES: ReadonlySet<string> = new Set([
  'run-event',
  'tool-approval-answered',
] satisfies StreamChunk['type'][]);

/**
 * Builds the `routePart` for one leg's stream
 * (`StreamInactivityOptions.routePart`).
 *
 * A background leg's stream is the host idle loop's COMBINED stream: the
 * parent's turns, every running child's parts folded in as
 * `background-task-output`, and the loop's bookkeeping. The parent watchdog
 * judges only the PARENT: a child's parts, the native lifecycle events and
 * host rows are bookkeeping, and each background task this leg dispatched or
 * resumed HOLDS the stream open until its terminal or suspension.
 *
 * Stateful per leg, mirroring the idle loop's own `settled` set: a terminal
 * can outrun the dispatch acknowledgement, so a released task is held again
 * only by `resumed`.
 *
 * Everything else is the parent's. A top-level delegation envelope stays the
 * parent's output: a foreground child's parts ride it as they always have,
 * and so do a resume leg's in-process child's raw envelopes.
 *
 * @internal exported for tests
 */
export function createMastraStreamPartRouter(): (part: unknown) => StreamPartRoute<unknown> {
  const released = new Set<string>();
  return (part) => {
    const type = describeMastraStreamPartType(part);
    if (type !== undefined && HOST_BOOKKEEPING_PART_TYPES.has(type)) {
      return { kind: 'bookkeeping' };
    }
    if (type === undefined || !Object.hasOwn(MASTRA_BACKGROUND_HOLD_EFFECTS, type)) {
      return { kind: 'produced', part };
    }
    const effect =
      MASTRA_BACKGROUND_HOLD_EFFECTS[type as keyof typeof MASTRA_BACKGROUND_HOLD_EFFECTS];
    const taskId = readMastraStreamPartString(part, 'taskId');
    if (effect === 'none' || taskId === undefined) {
      return { kind: 'bookkeeping' };
    }
    if (effect === 'releases') {
      released.add(taskId);
      return { kind: 'bookkeeping', releases: taskId };
    }
    if (effect === 'holds-again') {
      released.delete(taskId);
    }
    return released.has(taskId) ? { kind: 'bookkeeping' } : { holds: taskId, kind: 'bookkeeping' };
  };
}

/**
 * The classifiers every watchdog over ONE Mastra producer shares: a leg's
 * root stream and a background child's own stream judge their parts alike.
 */
export function resolveMastraProducerOptions(
  guardedToolNames: ReadonlySet<string>
): Pick<
  StreamInactivityOptions<unknown>,
  'countsAsProviderOutput' | 'describePart' | 'reasoningPartKind' | 'toolExecutionPartKind'
> {
  return {
    countsAsProviderOutput: isMastraProviderOutputPart,
    describePart: describeMastraStreamPartType,
    reasoningPartKind: readMastraReasoningPartKind,
    toolExecutionPartKind: createMastraToolExecutionPartKindReader(guardedToolNames),
  };
}
