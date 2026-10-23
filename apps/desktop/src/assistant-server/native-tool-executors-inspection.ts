/**
 * Language-server inspection, built over the shared build context so the
 * desktop agent host can run it in its own process. This module must not
 * import Electron: the host bundle loads it.
 */
import { type LspInspectInput, NATIVE_TOOL_INPUT_SCHEMAS } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  type NativeToolExecutor,
  parseToolExecuteInput,
  projectLspInspectModelOutput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { runLspInspect } from './lsp-inspection-tools';

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
