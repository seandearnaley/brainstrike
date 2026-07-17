/**
 * Plan-mode + suspend-storage gates. Two PURE tool-map filters applied in
 * `createMastraAgentRuntime` BEFORE the immutable Agent is built, alongside the
 * permission gate:
 *
 * 1. {@link filterToolsForPlanMode} — when the run is in plan mode, keep only
 *    read/mcp tools plus the suspending tools (`submitPlan`/`askUser`) and OMIT
 *    every edit/execute tool, so the model can investigate and propose a plan
 *    but cannot mutate anything until it is approved. Runs BEFORE the permission
 *    gate (a dropped mutation tool is dropped regardless of allow/ask/deny).
 *
 * 2. {@link resolveSuspendToolsForRun} — a tool that pauses via `suspend()` is
 *    useless without Mastra workflow storage to resume it, so without storage
 *    the suspending tools are FAIL-SAFE omitted (mirrors the ask-tools omit in
 *    `resolveAskToolsForRun`). Never run a suspend tool that cannot resume.
 *
 * A "suspending tool" is detected structurally by an own `suspendSchema`
 * property, so this needs no coupling to specific tool ids (future suspend tools
 * are covered automatically). {@link SUSPENDING_NATIVE_TOOL_IDS} anchors the two
 * v1 tools for registry/UX purposes.
 */

import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';

export const SUBMIT_PLAN_TOOL_ID = 'brainstrike.submitPlan';
export const ASK_USER_TOOL_ID = 'brainstrike.askUser';

/** The v1 suspending native tools (kept in plan mode; omitted without storage). */
export const SUSPENDING_NATIVE_TOOL_IDS: readonly string[] = [
  SUBMIT_PLAN_TOOL_ID,
  ASK_USER_TOOL_ID,
];

export interface PlanModeToolGateLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/** True when `tool` declares a Mastra `suspendSchema` (i.e. it can `suspend()`). */
export function hasSuspendSchema(tool: unknown): boolean {
  return Boolean(
    tool && typeof tool === 'object' && (tool as { suspendSchema?: unknown }).suspendSchema
  );
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
 * Keep only tools that are safe to expose while planning: risk ∈ {read, mcp} OR
 * a suspending tool (`submitPlan`/`askUser`). Every edit/execute tool is omitted
 * (logged). PURE — never mutates inputs; insertion order preserved.
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
    if (hasSuspendSchema(tool)) {
      kept[sanitizedId] = tool;
      continue;
    }
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

/**
 * Fail-safe for the suspending tools: without Mastra workflow storage a
 * `suspend()` can never resume, so OMIT the suspending tools (logged) rather
 * than run one that would wedge the run. PURE. With storage, returns the map
 * unchanged.
 */
export function resolveSuspendToolsForRun<TMap extends Record<string, unknown>>(
  tools: TMap,
  hasStorage: boolean,
  toolNameMap: ReadonlyMap<string, string>,
  logger: PlanModeToolGateLogger
): TMap {
  if (hasStorage) {
    return tools;
  }
  const reduced: Record<string, unknown> = {};
  for (const [sanitizedId, tool] of Object.entries(tools)) {
    if (hasSuspendSchema(tool)) {
      logger.warn('Suspending tool omitted; no workflow storage to resume it (fail-safe)', {
        code: 'suspend_tool_omitted_no_storage',
        sanitizedId,
        tool: toolNameMap.get(sanitizedId) ?? sanitizedId,
      });
      continue;
    }
    reduced[sanitizedId] = tool;
  }
  return reduced as TMap;
}
