/**
 * executeCommand, built over the shared build context so each agent host
 * (Desktop's, the standalone CLI's) runs it in its own process. The shell
 * supplies its own facts: the Windows wrapper it ships, and the worktree/forge
 * correlation its ledger has (Desktop: Main's narrow RPCs; none on the CLI).
 */
import {
  type ExecuteCommandInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  resolveGuardedToolSignal,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  runExecuteCommandWithShellCorrelation,
  type ShellCorrelationDependencies,
} from './execute-command-correlation.js';
import { projectExecuteCommandModelOutput } from './execute-command-model-projection.js';
import type { WindowsCommandEntry } from './execute-command-tool.js';
import type { NativeToolBuildContext } from './executors.js';
import type { NativeToolExecutor } from './host-tools.js';
import {
  logToolFailure,
  parseToolExecuteInput,
  resolveShellOutputStreamer,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from './tool-execute-support.js';

/** What a shell composes executeCommand with. */
export interface ExecuteCommandShell {
  /** The call's worktree/forge correlation; absent where the shell has no worktree ledger. */
  readonly correlation?: (context: NativeToolBuildContext) => ShellCorrelationDependencies;
  readonly windowsCommandEntry: WindowsCommandEntry;
}

/**
 * Arbitrary shell execution is registered like every other native tool and
 * gated by the permission engine. With enforce-on-by-default, its 'execute'
 * risk bucket resolves to 'ask', so the run SUSPENDS for per-call approval
 * before the command runs (approve → execute, decline → skip). A user can set
 * execute to 'allow'/yolo to run it unprompted, or 'deny' to omit it.
 */
export function executeCommandExecutor(shell: ExecuteCommandShell): NativeToolExecutor {
  return (context) => {
    const { resolveActiveDomainCharBudget, runtimeData } = context;
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.executeCommand],
      // The second arg carries the Mastra ToolExecutionContext, whose abortSignal
      // we thread into the run so a cancelled run kills the process tree, and
      // whose stream writer + tool-call id stream incremental stdout/stderr to
      // the live tool card. `resolveShellOutputStreamer` returns undefined when
      // neither writer shape is present: the command still runs and returns its
      // full captured result — only the live slices are skipped.
      execute: async (
        input: ToolExecuteInput<ExecuteCommandInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
          input
        );
        const stream = resolveShellOutputStreamer(options, (error) => {
          logToolFailure('executeCommand output streaming failed', error, resolvedInput);
        });
        try {
          // Mis-attribution guard (BST-1392 review) lives in
          // execute-command-correlation.ts.
          return await runExecuteCommandWithShellCorrelation(
            resolvedInput,
            runtimeData,
            {
              signal: resolveGuardedToolSignal(options),
              ...(stream ? { stream } : {}),
              windowsCommandEntry: shell.windowsCommandEntry,
            },
            shell.correlation?.(context) ?? {}
          );
        } catch (error) {
          logToolFailure('executeCommand failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.executeCommand,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
      toModelOutput: (output: unknown) =>
        projectExecuteCommandModelOutput(output, resolveActiveDomainCharBudget()),
    };
  };
}
