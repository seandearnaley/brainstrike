/**
 * grepSearch over a caller-supplied indexed half, so the desktop agent host
 * runs the tool (and its live ripgrep pass) in its own process while Main keeps
 * its file-chunk index. This module must not import Electron or Main's
 * database: the host bundle loads it.
 */
import { type GrepSearchInput, NATIVE_TOOL_INPUT_SCHEMAS } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  attachGrepSearchTelemetry,
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  projectGrepSearchModelOutput,
  readStateScope,
  type ToolExecuteInput,
  withRepeatedCallGuard,
} from '@brainstrike/host-capabilities/native-tools';
import { type GrepIndexSearch, runGrepSearchWith } from './grep-search-core';

export function grepSearchExecutor(index: GrepIndexSearch): NativeToolExecutor {
  return ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.grepSearch],
    execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
        input
      );
      try {
        return await withRepeatedCallGuard({
          input: resolvedInput,
          run: async () =>
            attachGrepSearchTelemetry(
              resolvedInput,
              await runGrepSearchWith(resolvedInput, runtimeData, index)
            ),
          threadScope: readStateScope(runtimeData),
          toolId: NATIVE_TOOL_ID.grepSearch,
        });
      } catch (error) {
        logToolFailure('grepSearch failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.grepSearch,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
    toModelOutput: (output: unknown) =>
      projectGrepSearchModelOutput(output, resolveActiveDomainCharBudget()),
  });
}
