/**
 * querySelf and queryDiagnostics over caller-supplied reads: Main reads its
 * own databases, the desktop agent host asks Main for the same typed reads.
 * This module must not import Electron or Main's database: the host bundle
 * loads it.
 */
import {
  NATIVE_TOOL_INPUT_SCHEMAS,
  type QueryDiagnosticsInput,
  type QuerySelfInput,
  resolveGuardedToolSignal,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { type DiagnosticsReader, runQueryDiagnosticsWith } from './query-diagnostics-core';
import { type QuerySelfRead, runQuerySelfWith, toQuerySelfInputError } from './query-self-core';
import { projectQuerySelfModelOutput } from './query-self-model-projection';

export function selfInspectionExecutors(
  read: QuerySelfRead,
  diagnostics: DiagnosticsReader
): {
  readonly [NATIVE_TOOL_ID.queryDiagnostics]: NativeToolExecutor;
  readonly [NATIVE_TOOL_ID.querySelf]: NativeToolExecutor;
} {
  return {
    [NATIVE_TOOL_ID.querySelf]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.querySelf],
      execute: async (input: ToolExecuteInput<QuerySelfInput>, options?: ToolExecuteContext) => {
        // Schema validation is INSIDE the try on purpose. For every other tool a
        // malformed call is a bug; for this one the model is authoring the input
        // freehand, so an opaque `tool_failed` leaves it no way to correct and it
        // simply retries the same call. Observed live: a rejected input produced
        // "The tool did not complete successfully" and the model gave up after
        // two identical attempts. `toToolInputError` turns the validation
        // message into text the model can act on.
        let resolvedInput: QuerySelfInput | undefined;
        try {
          resolvedInput = parseToolExecuteInput(
            NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.querySelf],
            input
          );
          return await runQuerySelfWith(resolvedInput, runtimeData, read, {
            signal: resolveGuardedToolSignal(options),
          });
        } catch (error) {
          logToolFailure('querySelf failed', error, resolvedInput ?? {});
          throw resolvedInput === undefined ? toQuerySelfInputError(error) : error;
        }
      },
      id: NATIVE_TOOL_ID.querySelf,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.querySelf],
      toModelOutput: (output: unknown) =>
        projectQuerySelfModelOutput(output, resolveActiveDomainCharBudget()),
    }),
    [NATIVE_TOOL_ID.queryDiagnostics]: () => ({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryDiagnostics],
      execute: async (input: ToolExecuteInput<QueryDiagnosticsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
          input
        );
        try {
          return await runQueryDiagnosticsWith(resolvedInput, diagnostics);
        } catch (error) {
          logToolFailure('queryDiagnostics failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.queryDiagnostics,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryDiagnostics],
    }),
  };
}
