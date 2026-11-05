/**
 * Language-server inspection, run by every agent host in its own process over
 * the thread's folders on disk.
 */
import { type LspInspectInput, NATIVE_TOOL_INPUT_SCHEMAS } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { NativeToolExecutor } from './host-tools.ts';
import { runLspInspect } from './lsp-inspection-tools.ts';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support.ts';
import { projectLspInspectModelOutput } from './workspace-inspection-model-projections.ts';

export const INSPECTION_TOOL_EXECUTORS: {
  readonly [NATIVE_TOOL_ID.lspInspect]: NativeToolExecutor;
} = {
  [NATIVE_TOOL_ID.lspInspect]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.lspInspect],
    execute: async (input: ToolExecuteInput<LspInspectInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.lspInspect],
        input
      );
      return await runLspInspect(resolvedInput, runtimeData);
    },
    id: NATIVE_TOOL_ID.lspInspect,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.lspInspect],
    toModelOutput: (output: unknown) =>
      projectLspInspectModelOutput(output, resolveActiveDomainCharBudget()),
  }),
};
