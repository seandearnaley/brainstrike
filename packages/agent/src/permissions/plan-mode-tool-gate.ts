/**
 * Plan-mode tool gate: a PURE tool-map filter applied to the run's tool map
 * BEFORE it is bound, alongside the permission gate. The host applies
 * {@link filterToolsForPlanMode} in
 * `packages/host-capabilities/src/workspace-context/host-system-context.ts`: when the run
 * is in plan mode, keep only risk ∈ {read, mcp} and OMIT every edit/execute
 * tool, so the model can investigate and propose a plan but cannot mutate
 * anything until it is approved. Runs BEFORE the permission gate (a dropped
 * mutation tool is dropped regardless of allow/ask/deny). `submitPlan`/`askUser`
 * survive because they are classified `read` — NOT because they suspend
 * (BST-1073).
 */

import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';

export interface PlanModeToolGateLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
}

/** Risk buckets that plan mode keeps (investigation/read-only + MCP). */
const PLAN_MODE_KEPT_RISK: ReadonlySet<ToolRiskCategory> = new Set<ToolRiskCategory>([
  'read',
  'mcp',
]);

function riskForTool(
  riskByTool: Readonly<Record<string, ToolRiskCategory>>,
  originalName: string,
  sanitizedId: string
): ToolRiskCategory {
  // Unclassified tools (e.g. freshly discovered MCP tools) fall to 'mcp' — the
  // same conservative default the permission gate uses — which plan mode keeps.
  return riskByTool[originalName] ?? riskByTool[sanitizedId] ?? 'mcp';
}

/**
 * Keep only tools that are safe to expose while planning: risk ∈ {read, mcp}.
 * Every edit/execute tool is omitted (logged). PURE — never mutates inputs;
 * insertion order preserved.
 *
 * A SUSPEND SCHEMA IS NOT AN ADMISSION TICKET (BST-1073). This function used to
 * keep any suspending tool before consulting its risk, which was safe only by
 * accident: the two tools carrying a suspend schema (`submitPlan`/`askUser`)
 * are both classified `read`, so the branch never actually admitted anything
 * the risk check would have rejected. It becomes a real hole the moment a
 * mutation tool needs to suspend — `run_python` requires one for its per-call
 * network escalation, and admitting an execute-risk arbitrary-code tool into
 * plan mode defeats the purpose of plan mode. Suspending tools are still kept
 * when their risk allows it (an unclassified tool falls to `mcp`, which is
 * kept), so `submitPlan`/`askUser` are unaffected.
 */
export function filterToolsForPlanMode<TMap extends Record<string, unknown>>(
  tools: TMap,
  toolNameMap: ReadonlyMap<string, string>,
  riskByTool: Readonly<Record<string, ToolRiskCategory>>,
  logger: PlanModeToolGateLogger
): TMap {
  const kept: Record<string, unknown> = {};
  let omittedCount = 0;
  for (const [sanitizedId, tool] of Object.entries(tools)) {
    const originalName = toolNameMap.get(sanitizedId) ?? sanitizedId;
    const risk = riskForTool(riskByTool, originalName, sanitizedId);
    if (PLAN_MODE_KEPT_RISK.has(risk)) {
      kept[sanitizedId] = tool;
      continue;
    }
    omittedCount += 1;
    logger.info('Tool omitted in plan mode (mutation tools are hidden while planning)', {
      code: 'plan_mode_tool_omitted',
      riskCategory: risk,
      sanitizedId,
      tool: originalName,
    });
  }
  if (omittedCount === 0) {
    logger.info('Plan mode active; no mutation tools to omit', {
      code: 'plan_mode_no_omissions',
    });
  }
  return kept as TMap;
}
