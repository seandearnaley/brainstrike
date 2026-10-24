/**
 * queryDiagnostics over a caller-supplied read: Main reads its own diagnostics
 * store, the desktop agent host asks Main for the same typed read. This module
 * must not import Electron or Main's database: the host bundle loads it.
 */
import { NATIVE_TOOL_INPUT_SCHEMAS, type QueryDiagnosticsInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { type DiagnosticsReader, runQueryDiagnosticsWith } from './query-diagnostics-core';

export function selfInspectionExecutors(diagnostics: DiagnosticsReader): {
  readonly [NATIVE_TOOL_ID.queryDiagnostics]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.queryDiagnostics]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryDiagnostics],
      execute: async (input: ToolExecuteInput<QueryDiagnosticsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
          input
        );
        return await runQueryDiagnosticsWith(resolvedInput, diagnostics);
      },
      id: NATIVE_TOOL_ID.queryDiagnostics,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
    }),
  };
}
