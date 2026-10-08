import {
  getActiveToolResultBudget,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeData,
} from '@brainstrike/agent';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { readWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { legacyNativeToolPorts } from './legacy-native-tool-ports';
import {
  type DesktopAssistantToolDependencies,
  type DesktopToolBuildContext,
  isLocalProviderRuntime,
  type MastraTools,
} from './native-tool-executor-context';
import { NATIVE_TOOL_EXECUTORS } from './native-tool-executors';
import { applyToolProjectionRewriteRecording } from './tool-projection-rewrite-repository';

export type { DesktopAssistantToolDependencies } from './native-tool-executor-context';

const logger = createLogger('DesktopAssistantTools');

/**
 * Builds the Mastra ToolsInput for the desktop assistant server: a fold of
 * the catalog (`DESKTOP_NATIVE_TOOL_IDS`) through the exhaustive executor map
 * (`NATIVE_TOOL_EXECUTORS`, one entry per definition — a missing entry is a
 * compile error). An entry returns `undefined` when its capability is absent
 * for this request (built-in local provider, no artifact reader, no skill
 * resolver); omission is the explicit capability result, never a fallback.
 */
export function buildDesktopAssistantTools(
  runtimeData: RuntimeData | undefined,
  dependencies: DesktopAssistantToolDependencies = {}
): MastraTools {
  const resolvedDomainCharBudget =
    dependencies.resolvedToolResultBudget?.domainModelResultCharBudget ??
    MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET;
  const context: DesktopToolBuildContext = {
    dependencies,
    isLocalProvider: isLocalProviderRuntime(runtimeData),
    ports:
      dependencies.nativeToolPorts ??
      legacyNativeToolPorts(runtimeData, dependencies.toolOutputArtifactReader),
    readFileCursorRegistry:
      dependencies.readWorkspaceFileCursorRegistry ?? readWorkspaceFileCursorRegistry,
    resolveActiveDomainCharBudget: () =>
      getActiveToolResultBudget()?.domainModelResultCharBudget ?? resolvedDomainCharBudget,
    resolvedDomainCharBudget,
    runtimeData,
  };
  const tools: MastraTools = {};
  for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
    const tool = NATIVE_TOOL_EXECUTORS[toolId](context);
    if (tool) {
      tools[toolId] = tool;
    }
  }

  const enabledNativeToolIds = runtimeData?.enabledNativeToolIds;
  if (!Array.isArray(enabledNativeToolIds)) {
    return tools;
  }

  const enabledSet = new Set(
    enabledNativeToolIds.filter((toolId): toolId is string => typeof toolId === 'string')
  );
  const unknownToolIds = Array.from(enabledSet).filter((toolId) => !isDesktopNativeToolId(toolId));
  if (unknownToolIds.length > 0) {
    throw new Error('Enabled native tool preferences contain unknown tool IDs.');
  }
  const unavailableToolIds = Array.from(enabledSet).filter(
    (toolId) =>
      tools[toolId] === undefined &&
      // Skill execution is capability-gated by the trusted per-request scan
      // engine. A persisted preference may still name it while Skills are
      // disabled; omission is the explicit capability result, not corruption.
      toolId !== NATIVE_TOOL_ID.runSkillScript &&
      // run_python is capability-gated twice over: absent for the built-in
      // local provider, and `createFenceExecutorFactory` yields undefined on
      // a host with no OS fence. Omission is the explicit capability result.
      toolId !== NATIVE_TOOL_ID.runPython
  );
  if (unavailableToolIds.length > 0) {
    logger.debug('Enabled native tool ids unavailable in the current runtime', {
      toolIds: unavailableToolIds,
    });
  }
  if (enabledSet.size === 0) {
    logger.warn('Runtime preferences disabled all desktop assistant native tools', {
      availableCount: Object.keys(tools).length,
    });
  }
  const filteredTools: MastraTools = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (enabledSet.has(toolId)) {
      filteredTools[toolId] = tool;
    }
  }
  const disabledCount = Object.keys(tools).length - Object.keys(filteredTools).length;
  if (disabledCount > 0) {
    logger.debug('Filtered desktop assistant native tools', {
      disabledCount,
      enabledCount: Object.keys(filteredTools).length,
    });
  }
  return applyToolProjectionRewriteRecording(filteredTools, runtimeData);
}
