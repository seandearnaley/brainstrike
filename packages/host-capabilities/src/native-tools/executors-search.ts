/**
 * The read-only workspace search entries every host runs in its own process:
 * globWorkspace and findWorkspaceSymbol. Neither needs a store or Main.
 */
import {
  type FindWorkspaceSymbolInput,
  type GlobWorkspaceInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { NativeToolBuildContext, NativeToolDefinition } from './executors.ts';
import { runFindWorkspaceSymbol } from './find-workspace-symbol-tool.ts';
import { runGlobWorkspace } from './glob-workspace-tool.ts';
import { withRepeatedCallGuard } from './tool-call-loop-guards.ts';
import { attachGlobWorkspaceTelemetry } from './tool-call-telemetry.ts';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support.ts';
import { readStateScope } from './workspace-file-staleness.ts';
import { projectFindWorkspaceSymbolModelOutput } from './workspace-inspection-model-projections.ts';
import { projectGlobWorkspaceModelOutput } from './workspace-search-model-projections.ts';

type SearchToolId = typeof NATIVE_TOOL_ID.findWorkspaceSymbol | typeof NATIVE_TOOL_ID.globWorkspace;

export const SEARCH_NATIVE_TOOL_EXECUTORS: {
  readonly [Id in SearchToolId]: (
    context: NativeToolBuildContext
  ) => NativeToolDefinition | undefined;
} = {
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.findWorkspaceSymbol],
    execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.findWorkspaceSymbol],
        input
      );
      return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
    },
    id: NATIVE_TOOL_ID.findWorkspaceSymbol,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.findWorkspaceSymbol],
    toModelOutput: (output: unknown) =>
      projectFindWorkspaceSymbolModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.globWorkspace]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.globWorkspace],
    execute: async (input: ToolExecuteInput<GlobWorkspaceInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
        input
      );
      return await withRepeatedCallGuard({
        input: resolvedInput,
        run: async () =>
          attachGlobWorkspaceTelemetry(
            resolvedInput,
            await runGlobWorkspace(resolvedInput, runtimeData)
          ),
        threadScope: readStateScope(runtimeData),
        toolId: NATIVE_TOOL_ID.globWorkspace,
      });
    },
    id: NATIVE_TOOL_ID.globWorkspace,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
    toModelOutput: (output: unknown) =>
      projectGlobWorkspaceModelOutput(output, resolveActiveDomainCharBudget()),
  }),
};
