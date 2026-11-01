/**
 * listWorktrees, manageWorktree and executeCommand's worktree correlation over
 * the host's own worktree ledger. Every agent host composes them the same way;
 * only the desktop can open a created worktree as a workspace folder.
 */
import { NATIVE_TOOL_ID, scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import type { ShellCorrelationDependencies } from '../native-tools/execute-command-correlation.ts';
import type { NativeToolBuildContext, NativeToolDefinition } from '../native-tools/executors.ts';
import {
  type HostWorktreeServices,
  hostWorktreeToolDependencies,
} from './worktree-tool-dependencies.ts';
import { buildWorktreeMastraTools, type WorktreeToolCapability } from './worktree-tools.ts';

/** The worktree tools (BST-1392), built only when the host lends its worktree capability. */
export function worktreeToolExecutors<Context extends NativeToolBuildContext>(
  capability: (context: Context) => WorktreeToolCapability | undefined
): {
  readonly [NATIVE_TOOL_ID.listWorktrees]: (context: Context) => NativeToolDefinition | undefined;
  readonly [NATIVE_TOOL_ID.manageWorktree]: (context: Context) => NativeToolDefinition | undefined;
} {
  return {
    [NATIVE_TOOL_ID.listWorktrees]: (context) =>
      buildWorktreeMastraTools(context.runtimeData, capability(context))[
        NATIVE_TOOL_ID.listWorktrees
      ],
    [NATIVE_TOOL_ID.manageWorktree]: (context) =>
      buildWorktreeMastraTools(
        context.runtimeData,
        capability(context),
        context.ports.enterWorktree
      )[NATIVE_TOOL_ID.manageWorktree],
  };
}

/** The worktree tools over the host's worktree services, each run under its own identity. */
export function hostWorktreeToolExecutors(services: HostWorktreeServices, threadId: string) {
  return worktreeToolExecutors(
    ({ runtimeData }) =>
      hostWorktreeToolDependencies(services, {
        runId: runtimeData?.memory?.runId,
        threadId,
      }).worktreeTools
  );
}

/**
 * A host command's worktree correlation over the host's own worktree
 * ledger: the pre-command path snapshot, then the completed command under the
 * host run's identity. Neither ever blocks the command; the reconcile fails
 * closed to "adopt nothing" without a snapshot.
 */
export function hostShellCorrelation(
  services: HostWorktreeServices,
  threadId: string
): (context: NativeToolBuildContext) => ShellCorrelationDependencies {
  return ({ ports, runtimeData }) => {
    const { shellCorrelation, worktreeTools } = hostWorktreeToolDependencies(services, {
      runId: runtimeData?.memory?.runId,
      threadId,
    });
    return {
      ...(shellCorrelation
        ? {
            shellCorrelation: {
              onCommandCompleted: (completed) => {
                // Only a git-worktree command has anything to correlate.
                if (!scanShellCommandForGitSignals(completed.command).touchedWorktrees) {
                  return;
                }
                const adopted = shellCorrelation
                  .onCommandCompleted(completed)
                  .then((rows) =>
                    rows.map(({ branch, id, path }) => ({ branch, path, worktreeId: id }))
                  );
                // Core commits each adopted worktree under this call, joined by its run.
                ports.shellWorktrees?.(adopted);
              },
            },
          }
        : {}),
      ...(worktreeTools ? { worktreeTools } : {}),
    };
  };
}
