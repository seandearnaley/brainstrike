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
import type { MastraTool, NativeToolBuildContext } from './executors.js';
import { runFindWorkspaceSymbol } from './find-workspace-symbol-tool.js';
import { runGlobWorkspace } from './glob-workspace-tool.js';
import { withRepeatedCallGuard } from './tool-call-loop-guards.js';
import { attachGlobWorkspaceTelemetry } from './tool-call-telemetry.js';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from './tool-execute-support.js';
import { readStateScope } from './workspace-file-staleness.js';
import { projectFindWorkspaceSymbolModelOutput } from './workspace-inspection-model-projections.js';
import { projectGlobWorkspaceModelOutput } from './workspace-search-model-projections.js';

type SearchToolId = typeof NATIVE_TOOL_ID.findWorkspaceSymbol | typeof NATIVE_TOOL_ID.globWorkspace;

export const SEARCH_NATIVE_TOOL_EXECUTORS: {
  readonly [Id in SearchToolId]: (context: NativeToolBuildContext) => MastraTool | undefined;
} = {
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.findWorkspaceSymbol],
    execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.findWorkspaceSymbol],
        input
      );
      try {
        return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('findWorkspaceSymbol failed', error, resolvedInput);
        throw error;
      }
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
      try {
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
      } catch (error) {
        logToolFailure('globWorkspace failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.globWorkspace,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
    toModelOutput: (output: unknown) =>
      projectGlobWorkspaceModelOutput(output, resolveActiveDomainCharBudget()),
  }),
};
