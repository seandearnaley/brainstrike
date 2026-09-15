/**
 * Permission tool gate (permission engine, step 3/4).
 *
 * This module FILTERS the agent's tool map by the user's permission policy
 * BEFORE the immutable Mastra `Agent` is constructed. It is the runtime
 * enforcement seam that consumes the pure decision resolver
 * (`resolvePermissionDecision`) and the risk taxonomy (`ToolRiskCategory`) from
 * `@brainstrike/assistant-contract`.
 *
 * How each decision is enforced:
 *   - `'allow'` → keep the tool unchanged (normal path); NOT in `askToolIds`.
 *   - `'deny'`  → omit the tool; the model never sees it.
 *   - `'ask'`   → keep the tool UNCHANGED here and record its sanitized id in
 *                 `askToolIds`/`askTools`. The composition site then clones it
 *                 with the FUNCTION form of Mastra's PER-TOOL `requireApproval`
 *                 (`applyLiveApprovalGate`, approval-gate.ts), which Mastra
 *                 evaluates on every call against the leg's live gate: it
 *                 SUSPENDS the step ONLY when that specific tool is actually
 *                 called and no remembered session grant allows it, and emits a
 *                 `tool-call-approval` part. The existing approval UI +
 *                 `streamMastraToolApprovalAction` resume chain turns that pause
 *                 into a prompt-then-resume ("Apply this edit? / Run this
 *                 command?"): approve → execute, decline → skip.
 *
 *                 PER-TOOL, not global: we DO NOT force the run-wide
 *                 `requireToolApproval` (a truthy one suspends EVERY tool call
 *                 and forces sequential steps, agent-DsRUDsS_.js:24054). The
 *                 flag is a FUNCTION, never a static `true` (settled
 *                 2026-09-15): a static flag is a copy Mastra takes once per
 *                 stream, so a remembered grant could never lift it — every
 *                 later read would still park, card and resume (70 cards on
 *                 the GLM run).
 *
 *                 We must NEVER silently downgrade `'ask'` to `'allow'` and run
 *                 an approval-required tool without prompting (no-silent-
 *                 fallbacks). The record and the clone move together: a kept ask
 *                 tool NOT in `askTools` is never cloned and would execute
 *                 unprompted (a security bug).
 *
 * Risk classification is CALLER-PROVIDED (`riskByTool` / `defaultRisk`). We do
 * NOT introspect Mastra tool objects for brainstrike metadata: the brainstrike
 * risk taxonomy is registry-side metadata that never rides on the Mastra tool
 * instance. The registry that builds the tool map owns the mapping.
 */

import {
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { sanitizeToolName } from './tool-sanitizer';

export type { PermissionToolGateSnapshot };

/**
 * Minimal logger surface the gate needs. A structural subset of the project
 * `ScopedLogger`, so the module-level `createLogger('MastraAgent')` satisfies it
 * without importing the agent's logger type here.
 */
export interface PermissionToolGateLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * The risk category applied to a tool that is absent from
 * {@link PermissionToolGateSnapshot.riskByTool}. Defaults to `'mcp'` — the most
 * restrictive sensible bucket, so an unclassified tool (e.g. a freshly
 * discovered MCP tool) is never treated as harmless `'read'` by accident.
 */
const FALLBACK_DEFAULT_RISK: ToolRiskCategory = 'mcp';

function riskForTool(
  snapshot: PermissionToolGateSnapshot,
  originalName: string,
  sanitizedId: string
): ToolRiskCategory {
  return (
    snapshot.riskByTool?.[originalName] ??
    snapshot.riskByTool?.[sanitizedId] ??
    snapshot.defaultRisk ??
    FALLBACK_DEFAULT_RISK
  );
}

interface ResolvedToolGateDecision {
  decision: 'allow' | 'ask' | 'deny';
  originalName: string;
  riskCategory: ToolRiskCategory;
}

/**
 * Resolve a single tool's permission decision + risk metadata. Extracted from
 * {@link filterToolsByPermissionWithMetadata} so the main loop stays simple.
 * Propagates {@link InvalidPermissionPolicyError} on a malformed policy/override.
 */
function resolveToolGateDecision(
  sanitizedId: string,
  snapshot: PermissionToolGateSnapshot,
  toolNameMap: ReadonlyMap<string, string>,
  sessionGrantSet: ReadonlySet<ToolRiskCategory>
): ResolvedToolGateDecision {
  const originalName = toolNameMap.get(sanitizedId) ?? sanitizedId;
  const riskCategory = riskForTool(snapshot, originalName, sanitizedId);
  const decision = resolvePermissionDecision({
    policies: snapshot.policies,
    riskCategory,
    sessionGrants: sessionGrantSet,
    toolId: originalName,
    yolo: snapshot.yolo,
    ...(snapshot.perToolOverrides ? { perToolOverrides: snapshot.perToolOverrides } : {}),
  });
  return { decision, originalName, riskCategory };
}

/** Per-tool risk metadata recorded for an `'ask'`-gated tool. */
export interface PermissionAskToolMetadata {
  /** The original (pre-sanitization) tool name, for logging/diagnostics. */
  originalName: string;
  /** The risk bucket that resolved to `'ask'`. */
  riskCategory: ToolRiskCategory;
}

/**
 * Resolve an `'ask'` tool's risk metadata by EITHER name form: the sanitized
 * registered id (the map key — Mastra's approval parts carry it today) or the
 * ORIGINAL pre-sanitization name (`meta.originalName` — what every client-facing
 * approval surface is keyed by, and what a future Mastra emitting original names
 * would carry). Returns `undefined` on a miss; the caller decides how loudly to
 * surface that (a policy-driven pause with unresolved metadata is an error-level
 * event — see `makeApprovalRequiredChunks`).
 *
 * DELIBERATELY a lookup helper, NOT a dual-keyed map: `askTools` must stay
 * single-keyed by sanitized id because `askTools.size === 0` denotes an explicit
 * GLOBAL approval request (see `resolveRequireToolApproval`, approval-gate.ts) and the gate logs
 * one entry per ask tool — dual-keying would corrupt both.
 */
export function resolveAskToolMetadata(
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>,
  name: string
): PermissionAskToolMetadata | undefined {
  const direct = askTools.get(name);
  if (direct) {
    return direct;
  }
  for (const meta of askTools.values()) {
    if (meta.originalName === name) {
      return meta;
    }
  }
  return;
}

/**
 * The result of gating a tool map: the (possibly reduced) tool map — every kept
 * tool unchanged — plus the set of sanitized ids of the `'ask'` tools.
 * `askToolIds`/`askTools` drive the runtime's storage fail-safe, the
 * approval-pause risk hint and the live predicate that makes Mastra suspend
 * (`approval-gate.ts`; see module comment).
 */
export interface FilterToolsByPermissionResult<TMap extends Record<string, unknown>> {
  /** Sanitized ids of every `'ask'`-gated tool kept in the map. */
  askToolIds: ReadonlySet<string>;
  /** Sanitized id → risk metadata for each `'ask'`-gated tool kept in the map. */
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>;
  /** The gated tool map (deny tools omitted; allow + ask tools kept). */
  tools: TMap;
}

/**
 * Filter a guarded Mastra tool map by the permission policy snapshot, returning
 * BOTH the filtered map and the `'ask'`-gated tool ids.
 *
 * PURE: it reads the inputs, builds a new map + set, and never mutates
 * `guardedTools`, the snapshot, or `toolNameMap`. Insertion order of kept tools
 * is preserved.
 *
 * For each tool (keyed by its sanitized id in `guardedTools`):
 * 1. `originalName = toolNameMap.get(sanitizedId) ?? sanitizedId`.
 * 2. `risk = riskByTool[originalName] ?? riskByTool[sanitizedId] ?? defaultRisk ?? 'mcp'`.
 * 3. `decision = resolvePermissionDecision({ riskCategory: risk, toolId: originalName, ... })`.
 *    - `'allow'` → keep; not in `askToolIds`.
 *    - `'deny'`  → omit + `logger.info`.
 *    - `'ask'`   → KEEP unchanged + record in `askToolIds` + `logger.info` (the
 *                  runtime's live predicate makes Mastra suspend for approval).
 *
 * When `snapshot` is `undefined`, the map is returned UNCHANGED with an empty
 * `askToolIds` — this preserves the current production behavior (no policy
 * threaded → no filtering, no forced approval), so the gate is fully backward
 * compatible and opt-in.
 *
 * STRICT: a malformed policy/override surfaces as {@link InvalidPermissionPolicyError}
 * from the resolver and is propagated, never swallowed (no-silent-fallbacks).
 *
 * @throws {InvalidPermissionPolicyError} when a policy/override value is invalid.
 */
export function filterToolsByPermissionWithMetadata<TMap extends Record<string, unknown>>(
  guardedTools: TMap,
  snapshot: PermissionToolGateSnapshot | undefined,
  toolNameMap: ReadonlyMap<string, string>,
  logger: PermissionToolGateLogger
): FilterToolsByPermissionResult<TMap> {
  // Production-unchanged path: no policy threaded → no filtering, no approval.
  if (!snapshot) {
    return { askToolIds: new Set<string>(), askTools: new Map(), tools: guardedTools };
  }

  // The resolver expects a ReadonlySet; the serializable snapshot carries an
  // array. Adapt once, not per-tool.
  const sessionGrantSet: ReadonlySet<ToolRiskCategory> = new Set<ToolRiskCategory>(
    snapshot.sessionGrants ?? []
  );

  const filtered: Record<string, unknown> = {};
  const askToolIds = new Set<string>();
  const askTools = new Map<string, PermissionAskToolMetadata>();
  for (const [sanitizedId, tool] of Object.entries(guardedTools)) {
    // Propagates InvalidPermissionPolicyError on a malformed policy/override.
    const { decision, originalName, riskCategory } = resolveToolGateDecision(
      sanitizedId,
      snapshot,
      toolNameMap,
      sessionGrantSet
    );

    if (decision === 'deny') {
      logger.info('Tool omitted by permission policy (deny)', {
        code: 'permission_tool_gate_deny',
        riskCategory,
        sanitizedId,
        tool: originalName,
      });
      continue;
    }

    // 'allow' and 'ask' both keep the tool UNCHANGED here. An 'ask' tool is
    // recorded in `askToolIds`/`askTools`; the composition site clones it
    // with the function-form per-tool flag (`applyLiveApprovalGate`,
    // approval-gate.ts) that Mastra evaluates on every call, so a remembered
    // session grant lifts the gate on the next call instead of parking,
    // carding and resuming every later read (70 cards on the GLM run,
    // 2026-09-15).
    //
    // SUSPENDING tools (run_python, submitPlan, askUser) are ordinary ask
    // tools here: the per-call flag is Gate A, their own `suspend()` is Gate
    // B, and the resume transport's `approved: true` rider keeps Gate B
    // resumable (attempt-legs.ts, createToolResumeTurnAttempt).
    filtered[sanitizedId] = tool;
    if (decision === 'ask') {
      askToolIds.add(sanitizedId);
      askTools.set(sanitizedId, { originalName, riskCategory });
      logger.info("Tool gated to 'ask' by permission policy (will suspend for per-call approval)", {
        code: 'permission_tool_gate_ask_suspend',
        riskCategory,
        sanitizedId,
        tool: originalName,
      });
    }
  }

  return { askToolIds, askTools, tools: filtered as TMap };
}

/**
 * The Gate A decision run_python consults inside `execute()` for its
 * DIRECT-invocation guard (BST-1097; since the @mastra/core 1.56 approval
 * rework the in-run Gate A is the framework's pre-execution approval driven by
 * the runtime's live predicate, so inside an agent run this decision arms
 * nothing). Resolves
 * the SAME permission decision the gate computes for that tool — same
 * resolver, same risk lookup — so the tool and the gate cannot disagree:
 *
 * - No snapshot (enforcement off) → `'allow'`: the permission engine gates
 *   nothing, exactly as the live predicate gates nothing with an empty ask set.
 * - `'allow'` (policy / per-tool override / session grant / yolo) → `'allow'`.
 * - `'ask'` → `'ask'`: a direct invocation (no suspension channel, no
 *   framework gate) refuses rather than running unprompted.
 * - `'deny'` → `'ask'` (fail-safe): a denied tool never enters the gated map,
 *   so inside an agent run this is unreachable; on a DIRECT invocation the
 *   safe direction is to require confirmation, and with no suspension channel
 *   available the tool then refuses rather than running.
 *
 * @throws {InvalidPermissionPolicyError} on a malformed policy/override —
 * propagated, never coerced (no-silent-fallbacks).
 */
export function resolveSelfApprovalDecision(
  snapshot: PermissionToolGateSnapshot | undefined,
  toolId: string
): 'allow' | 'ask' {
  if (!snapshot) {
    return 'allow';
  }
  // Same DUAL name-form lookup as the gate's own resolution: `riskByTool` may
  // be keyed by the original dotted id OR the Mastra-sanitized id, and the
  // gate accepts either. Passing only the dotted form here would fall back to
  // `defaultRisk` ('mcp' → 'allow') for a sanitized-keyed snapshot — an
  // unprompted run, the exact drift this helper exists to make impossible.
  const riskCategory = riskForTool(snapshot, toolId, sanitizeToolName(toolId));
  const decision = resolvePermissionDecision({
    policies: snapshot.policies,
    riskCategory,
    sessionGrants: new Set<ToolRiskCategory>(snapshot.sessionGrants ?? []),
    toolId,
    yolo: snapshot.yolo,
    ...(snapshot.perToolOverrides ? { perToolOverrides: snapshot.perToolOverrides } : {}),
  });
  return decision === 'allow' ? 'allow' : 'ask';
}
