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
 *   - `'allow'` → keep the tool (normal path); NOT in `askToolIds`.
 *   - `'deny'`  → omit the tool; the model never sees it.
 *   - `'ask'`   → KEEP the tool, but record its sanitized id in `askToolIds`.
 *                 The runtime (`createMastraAgentRuntime` →
 *                 `streamMastraAgent`) then forces the GLOBAL
 *                 `requireToolApproval: true` for the run when `askToolIds` is
 *                 non-empty, so Mastra SUSPENDS the step before executing the
 *                 tool and emits a `tool-call-approval` part. The existing
 *                 approval UI + `streamMastraToolApprovalAction` resume chain
 *                 turns that pause into a prompt-then-resume ("Apply this edit? /
 *                 Run this command?"): approve → execute, decline → skip.
 *
 *                 We must NEVER silently downgrade `'ask'` to `'allow'` and run
 *                 an approval-required tool without prompting (no-silent-
 *                 fallbacks). If an `'ask'` tool is ever left in the map WITHOUT
 *                 being recorded in `askToolIds`, the run would not suspend and
 *                 the tool would execute unprompted — that is a security bug, so
 *                 the two MUST move together.
 *
 * Mastra-v1 coarseness (documented, deliberate): Mastra exposes only a GLOBAL
 * `requireToolApproval`, not a per-tool `requireApproval`/`suspendSchema`. So a
 * single `'ask'` tool suspends the WHOLE step (every tool call in it) for
 * approval, not just the ask tool. With the default policy (read/mcp allow,
 * edit/execute ask) this is acceptable — read/mcp tools run free and only a
 * mutation in the step triggers the prompt. The runtime logs which tool(s)/risk
 * triggered the gate so the coarseness is observable.
 *
 * Risk classification is CALLER-PROVIDED (`riskByTool` / `defaultRisk`). We do
 * NOT introspect Mastra tool objects for brainstrike metadata: guard cloning
 * preserves a tool's own id/description/schema, but the brainstrike risk
 * taxonomy is registry-side metadata that never rides on the Mastra tool
 * instance. The registry that builds the tool map owns the mapping.
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
 * The result of gating a tool map: the (possibly reduced) tool map plus the set
 * of sanitized tool ids whose decision was `'ask'`. A non-empty `askToolIds`
 * tells the runtime to force the GLOBAL `requireToolApproval: true` so Mastra
 * suspends the step for per-call approval (see module comment).
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

    // 'allow' and 'ask' both KEEP the tool. For 'ask', additionally record it so
    // the runtime forces the global requireToolApproval → Mastra suspends the
    // step before executing it, and the existing approval UI + resume chain
    // prompts the user ("Apply this edit? / Run this command?"). The id MUST be
    // recorded whenever an 'ask' tool is kept — leaving it out would let an
    // approval-required tool run unprompted (a security bug, not a fallback).
    filtered[sanitizedId] = tool;
    if (decision === 'ask') {
      askToolIds.add(sanitizedId);
      askTools.set(sanitizedId, { originalName, riskCategory });
      logger.info("Tool gated to 'ask' by permission policy (run will suspend for approval)", {
        code: 'permission_tool_gate_ask_suspend',
        tool: originalName,
        sanitizedId,
        riskCategory,
      });
    }
  }

  return { tools: filtered as TMap, askToolIds, askTools };
}
