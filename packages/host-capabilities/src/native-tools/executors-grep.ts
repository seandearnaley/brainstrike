/**
 * grepSearch, run by every agent host in its own process over the thread's
 * folders on disk (ADR 0026: the core lane never asks Main's index).
 */
import { type GrepSearchInput, NATIVE_TOOL_INPUT_SCHEMAS } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { runGrepSearchWith } from './grep-search-core.ts';
import type { NativeToolExecutor } from './host-tools.ts';
import { withRepeatedCallGuard } from './tool-call-loop-guards.ts';
import { attachGrepSearchTelemetry } from './tool-call-telemetry.ts';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support.ts';
import { readStateScope } from './workspace-file-staleness.ts';
import { projectGrepSearchModelOutput } from './workspace-search-model-projections.ts';

export function grepSearchExecutor(): NativeToolExecutor {
  return ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.grepSearch],
    execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
        input
      );
      return await withRepeatedCallGuard({
        input: resolvedInput,
        run: async () =>
          attachGrepSearchTelemetry(
            resolvedInput,
            await runGrepSearchWith(resolvedInput, runtimeData)
          ),
        threadScope: readStateScope(runtimeData),
        toolId: NATIVE_TOOL_ID.grepSearch,
      });
    },
    id: NATIVE_TOOL_ID.grepSearch,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
    toModelOutput: (output: unknown) =>
      projectGrepSearchModelOutput(output, resolveActiveDomainCharBudget()),
  });
}
