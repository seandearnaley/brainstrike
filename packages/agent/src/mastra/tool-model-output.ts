import type { ToolsInput } from '@mastra/core/agent';

import {
  boundToolOutputForModel,
  MAX_MODEL_TOOL_RESULT_TOKENS,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';

type ExecutableToolWithModelOutput = ToolsInput[string] & {
  readonly execute: (...args: unknown[]) => unknown;
  readonly toModelOutput?: (output: unknown) => unknown;
};

function isExecutableTool(tool: unknown): tool is ExecutableToolWithModelOutput {
  return Boolean(
    tool &&
      typeof tool === 'object' &&
      typeof (tool as { execute?: unknown }).execute === 'function'
  );
}

function serializeBoundedOutput(toolName: string, output: unknown): string {
  const modelTokenBudget =
    toolName === 'skill' ? SKILL_ACTIVATION_RESULT_TOKEN_BUDGET : MAX_MODEL_TOOL_RESULT_TOKENS;
  const bounded = boundToolOutputForModel(toolName, output, modelTokenBudget).output;
  if (typeof bounded === 'string') {
    return bounded;
  }
  const serialized = JSON.stringify(bounded);
  return serialized ?? String(bounded);
}

/**
 * Give every execute-backed tool a Mastra-native model projection while keeping
 * its raw execution result intact for persistence and application consumers.
 *
 * Existing tool-specific projections are authoritative and are never replaced.
 * The generic projection is the final safety net for native and MCP tools that
 * do not yet define a more concise, domain-specific representation.
 */
export function applyToolModelOutputProjections(
  tools: ToolsInput,
  toolNameMap: ReadonlyMap<string, string>
): ToolsInput {
  const projected: ToolsInput = {};

  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isExecutableTool(tool)) {
      projected[toolId] = tool;
      continue;
    }

    if (tool.toModelOutput !== undefined) {
      if (typeof tool.toModelOutput !== 'function') {
        throw new TypeError(`${toolId} declares a non-callable toModelOutput`);
      }
      projected[toolId] = tool;
      continue;
    }

    const originalToolName = toolNameMap.get(toolId) ?? toolId;
    const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableToolWithModelOutput;
    Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
    Object.defineProperty(cloned, 'toModelOutput', {
      configurable: true,
      enumerable: true,
      value: (output: unknown) => ({
        type: 'text',
        value: serializeBoundedOutput(originalToolName, output),
      }),
      writable: true,
    });
    projected[toolId] = cloned;
  }

  return projected;
}
