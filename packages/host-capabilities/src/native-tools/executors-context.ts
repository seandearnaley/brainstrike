/**
 * The curated workspace-context reads, built over the shared build context so
 * an agent host runs them in its own process.
 */
import {
  type ListWorkspaceContextInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type ReadWorkspaceContextInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { NativeToolExecutor } from './host-tools.ts';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support.ts';
import { projectListWorkspaceContextModelOutput } from './workspace-context-model-projection.ts';
import {
  runListWorkspaceContext,
  runReadWorkspaceContext,
  type WorkspaceIndexSummary,
} from './workspace-context-read-tools.ts';

/** The curated-context read tools' ids, for the host's executed-tool set. */
export const CONTEXT_READ_TOOL_IDS = [
  NATIVE_TOOL_ID.listWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceContext,
] as const;

/** The workspace-context reads; the listing reports the native index status `readWorkspaceIndex` returns. */
export function contextReadExecutors(readWorkspaceIndex: () => Promise<WorkspaceIndexSummary>): {
  readonly [NATIVE_TOOL_ID.listWorkspaceContext]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.readWorkspaceContext]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.listWorkspaceContext]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
          input
        );
        return runListWorkspaceContext(resolvedInput, runtimeData, await readWorkspaceIndex());
      },
      id: NATIVE_TOOL_ID.listWorkspaceContext,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
      toModelOutput: (output: unknown) =>
        projectListWorkspaceContextModelOutput(output, resolveActiveDomainCharBudget()),
    }),
    [NATIVE_TOOL_ID.readWorkspaceContext]: ({ runtimeData }) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceContext],
      execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
          input
        );
        return await runReadWorkspaceContext(resolvedInput, runtimeData);
      },
      id: NATIVE_TOOL_ID.readWorkspaceContext,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
    }),
  };
}
