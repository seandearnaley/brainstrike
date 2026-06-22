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
 *   - `'ask'`   → keep a CLONE of the tool with Mastra's PER-TOOL
 *                 `requireApproval: true`, and record its sanitized id in
 *                 `askToolIds`. Mastra SUSPENDS the step ONLY when that specific
 *                 tool is actually called (not for unrelated allowed tools in
 *                 the same run) and emits a `tool-call-approval` part. The
 *                 existing approval UI + `streamMastraToolApprovalAction` resume
 *                 chain turns that pause into a prompt-then-resume ("Apply this
 *                 edit? / Run this command?"): approve → execute, decline → skip.
 *
 *                 PER-TOOL, not global: Mastra >=1.37 supports a per-tool
 *                 `requireApproval` flag, so we DO NOT force the run-wide
 *                 `requireToolApproval` (that suspends EVERY tool call in the
 *                 run, including `read`/`mcp` tools the user configured to allow,
 *                 breaking the read-only default flow). Marking only the ask
 *                 tools keeps allowed tools running free while gating mutations.
 *
 *                 We must NEVER silently downgrade `'ask'` to `'allow'` and run
 *                 an approval-required tool without prompting (no-silent-
 *                 fallbacks). An `'ask'` tool kept in the map MUST carry
 *                 `requireApproval: true` and be recorded in `askToolIds` — both
 *                 move together; a kept ask tool without the flag would execute
 *                 unprompted (a security bug).
 *
 * Risk classification is CALLER-PROVIDED (`riskByTool` / `defaultRisk`). We do
 * NOT introspect Mastra tool objects for brainstrike metadata: cloning preserves
 * a tool's own id/description/schema/prototype, but the brainstrike risk taxonomy
 * is registry-side metadata that never rides on the Mastra tool instance. The
 * registry that builds the tool map owns the mapping.
 */

import {
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';

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

/**
 * Return a CLONE of a Mastra tool with `requireApproval: true` set, so Mastra
 * suspends the step for per-call approval when (and only when) this specific
 * tool is invoked. Mirrors `applyToolGuards`' clone pattern: preserve the tool's
 * prototype (it may be a Mastra `Tool` class instance) and copy every own
 * property descriptor, then override the one field. The input tool is never
 * mutated. A non-object tool is returned unchanged (defensive; the gate only
 * ever sees real tool objects).
 */
function withRequireApproval<T>(tool: T): T {
  if (!tool || typeof tool !== 'object') {
    return tool;
  }
  const cloned = Object.create(Object.getPrototypeOf(tool)) as Record<string, unknown>;
  Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
  cloned['requireApproval'] = true;
  return cloned as T;
}

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
    riskCategory,
    toolId: originalName,
    policies: snapshot.policies,
    yolo: snapshot.yolo,
    sessionGrants: sessionGrantSet,
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
 * The result of gating a tool map: the (possibly reduced) tool map — where each
 * `'ask'` tool is a CLONE carrying `requireApproval: true` — plus the set of
 * sanitized ids of those ask tools. `askToolIds`/`askTools` drive the runtime's
 * storage fail-safe and the approval-pause risk hint; the per-tool
 * `requireApproval` flag (not a global one) is what makes Mastra suspend (see
 * module comment).
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
 *    - `'ask'`   → KEEP + record in `askToolIds` + `logger.info` (the runtime
 *                  forces requireToolApproval so Mastra suspends for approval).
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
    return { tools: guardedTools, askToolIds: new Set<string>(), askTools: new Map() };
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
        tool: originalName,
        sanitizedId,
        riskCategory,
      });
      continue;
    }

    // 'allow' keeps the tool unchanged. 'ask' keeps a CLONE with the per-tool
    // `requireApproval: true` flag so Mastra suspends ONLY when this tool is
    // called (allowed tools in the same run still run free) — and records it for
    // the storage fail-safe + risk hint. The clone + the askToolIds entry MUST
    // move together: a kept ask tool without the flag would run unprompted (a
    // security bug, not a fallback).
    if (decision === 'ask') {
      filtered[sanitizedId] = withRequireApproval(tool);
      askToolIds.add(sanitizedId);
      askTools.set(sanitizedId, { originalName, riskCategory });
      logger.info("Tool gated to 'ask' by permission policy (will suspend for per-call approval)", {
        code: 'permission_tool_gate_ask_suspend',
        tool: originalName,
        sanitizedId,
        riskCategory,
      });
    } else {
      filtered[sanitizedId] = tool;
    }
  }

  return { tools: filtered as TMap, askToolIds, askTools };
}
