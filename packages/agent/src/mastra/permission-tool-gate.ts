/**
 * Permission tool gate (permission engine, step 3/4).
 *
 * This module FILTERS the agent's tool map by the user's permission policy
 * BEFORE the immutable Mastra `Agent` is constructed. It is the runtime
 * enforcement seam that consumes the pure decision resolver
 * (`resolvePermissionDecision`) and the risk taxonomy (`ToolRiskCategory`) from
 * `@brainstrike/assistant-contract`.
 *
 * Why filter (omit), not suspend:
 * Mastra v1 exposes only a GLOBAL `requireToolApproval` that forces the whole
 * step sequential — there is NO per-tool `requireApproval`/`suspendSchema`. So a
 * per-tool `'ask'` SUSPEND cannot be wired yet. Until that capability lands
 * (PR-1.4 + the first real `'edit'` tool + a Mastra per-tool gate), the only
 * safe runtime action for a non-`'allow'` decision is to OMIT the tool from the
 * map the model sees:
 *   - `'allow'` → keep the tool (normal path).
 *   - `'deny'`  → omit the tool; the model never sees it.
 *   - `'ask'`   → omit the tool, FAIL-SAFE. We must NEVER silently downgrade
 *                 `'ask'` to `'allow'` and run an approval-required tool without
 *                 approval (no-silent-fallbacks). Real per-tool `'ask'` SUSPEND
 *                 (prompt-then-resume) lands later; this is a deliberate,
 *                 logged, conservative omission, not a downgrade.
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

/**
 * Filter a guarded Mastra tool map by the permission policy snapshot.
 *
 * PURE: it reads the inputs, builds a new map, and never mutates `guardedTools`,
 * the snapshot, or `toolNameMap`. Insertion order of kept tools is preserved.
 *
 * For each tool (keyed by its sanitized id in `guardedTools`):
 * 1. `originalName = toolNameMap.get(sanitizedId) ?? sanitizedId`.
 * 2. `risk = riskByTool[originalName] ?? riskByTool[sanitizedId] ?? defaultRisk ?? 'mcp'`.
 * 3. `decision = resolvePermissionDecision({ riskCategory: risk, toolId: originalName, ... })`.
 *    - `'allow'` → keep.
 *    - `'deny'`  → omit + `logger.info`.
 *    - `'ask'`   → omit + `logger.warn` (FAIL-SAFE; see module comment).
 *
 * When `snapshot` is `undefined`, the map is returned UNCHANGED — this preserves
 * the current production behavior (no policy threaded → no filtering), so the
 * gate is fully backward compatible and opt-in.
 *
 * STRICT: a malformed policy/override surfaces as {@link InvalidPermissionPolicyError}
 * from the resolver and is propagated, never swallowed (no-silent-fallbacks).
 *
 * @throws {InvalidPermissionPolicyError} when a policy/override value is invalid.
 */
export function filterToolsByPermission<TMap extends Record<string, unknown>>(
  guardedTools: TMap,
  snapshot: PermissionToolGateSnapshot | undefined,
  toolNameMap: ReadonlyMap<string, string>,
  logger: PermissionToolGateLogger
): TMap {
  // Production-unchanged path: no policy threaded → no filtering.
  if (!snapshot) {
    return guardedTools;
  }

  const { policies, yolo, sessionGrants, perToolOverrides } = snapshot;
  // The resolver expects a ReadonlySet; the serializable snapshot carries an
  // array. Adapt once, not per-tool.
  const sessionGrantSet: ReadonlySet<ToolRiskCategory> = new Set<ToolRiskCategory>(
    sessionGrants ?? []
  );

  const filtered: Record<string, unknown> = {};
  for (const [sanitizedId, tool] of Object.entries(guardedTools)) {
    const originalName = toolNameMap.get(sanitizedId) ?? sanitizedId;
    const riskCategory = riskForTool(snapshot, originalName, sanitizedId);

    // Propagates InvalidPermissionPolicyError on a malformed policy/override.
    const decision = resolvePermissionDecision({
      riskCategory,
      toolId: originalName,
      policies,
      yolo,
      sessionGrants: sessionGrantSet,
      ...(perToolOverrides ? { perToolOverrides } : {}),
    });

    if (decision === 'allow') {
      filtered[sanitizedId] = tool;
      continue;
    }

    if (decision === 'deny') {
      logger.info('Tool omitted by permission policy (deny)', {
        code: 'permission_tool_gate_deny',
        tool: originalName,
        sanitizedId,
        riskCategory,
      });
      continue;
    }

    // decision === 'ask': FAIL-SAFE omission. Mastra v1 has no per-tool suspend,
    // so we cannot prompt-then-resume for a single tool. Omitting is the only
    // safe action — NEVER silently run an approval-required tool. Real per-tool
    // 'ask' SUSPEND lands later (PR-1.4 + first real 'edit' tool + a Mastra
    // per-tool gate); until then this is a deliberate, logged omission.
    logger.warn(
      "Tool omitted by permission policy ('ask' is fail-safe-omitted; per-tool approval not yet supported by Mastra)",
      {
        code: 'permission_tool_gate_ask_omitted',
        tool: originalName,
        sanitizedId,
        riskCategory,
      }
    );
  }

  return filtered as TMap;
}
