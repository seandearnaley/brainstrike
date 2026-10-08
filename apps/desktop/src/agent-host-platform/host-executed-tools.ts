import { NATIVE_TOOL_ID, scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import {
  isSharedNativeToolId,
  type NativeToolExecutor,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import type { ShellCorrelationDependencies } from '../assistant-server/execute-command-correlation';
import type { GrepIndexSearch } from '../assistant-server/grep-search-core';
import { CONTEXT_TOOL_EXECUTORS } from '../assistant-server/native-tool-executors-context';
import { grepSearchExecutor } from '../assistant-server/native-tool-executors-grep';
import { INSPECTION_TOOL_EXECUTORS } from '../assistant-server/native-tool-executors-inspection';
import { executeCommandExecutor } from '../assistant-server/native-tool-executors-shell';
import { GrepIndexResultSchema, WorktreePathsResultSchema } from './host-tool-wire';

const logger = createLogger('DesktopHostTools');

/** Desktop tools the agent host runs in its own process beside the shared ones. */
const DESKTOP_HOST_TOOL_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(CONTEXT_TOOL_EXECUTORS),
  ...Object.keys(INSPECTION_TOOL_EXECUTORS),
  NATIVE_TOOL_ID.executeCommand,
  NATIVE_TOOL_ID.grepSearch,
]);

/** Main admits these but never executes them for a host thread. */
export function isHostExecutedNativeToolId(id: string): boolean {
  return isSharedNativeToolId(id) || DESKTOP_HOST_TOOL_IDS.has(id);
}

type MainRequest = (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

/**
 * A host command's worktree/forge correlation, through Main's narrow RPCs until
 * the worktree ledger is a host fact: the pre-command path snapshot, then the
 * completed command under the host run's identity. Neither ever blocks the
 * command; the reconcile fails closed to "adopt nothing" without a snapshot.
 */
function hostShellCorrelation(
  request: MainRequest,
  threadId: string,
  runId: string | undefined
): ShellCorrelationDependencies {
  return {
    shellCorrelation: {
      onCommandCompleted: ({ command, precedingWorktreePaths, rootId }) => {
        // Only a git-worktree or PR-creating command has anything for Main to correlate.
        const signals = scanShellCommandForGitSignals(command);
        if (!(signals.touchedWorktrees || signals.createdPullRequest)) {
          return;
        }
        request('platform/shell/completed', {
          command,
          precedingWorktreePaths: precedingWorktreePaths ? [...precedingWorktreePaths] : null,
          rootId,
          ...(runId ? { runId } : {}),
          threadId,
        }).catch((error: unknown) => {
          logger.error('shell correlation request failed', { error, rootId });
        });
      },
    },
    worktreeTools: {
      list: async () => {
        const { paths } = WorktreePathsResultSchema.parse(
          await request('platform/worktree/paths', { threadId })
        );
        return paths
          ? { ok: true, value: paths.map((path) => ({ path })) }
          : { error: 'Worktrees are unavailable in this session.', ok: false };
      },
    },
  };
}

/** grep's indexed half: a typed read of Main's file-chunk index for an admitted thread. */
function hostGrepIndex(request: MainRequest, threadId: string): GrepIndexSearch {
  return async (options) =>
    GrepIndexResultSchema.parse(
      await request('desktop-read/grep-index', {
        options: {
          ...options,
          ...(options.filePaths ? { filePaths: [...options.filePaths] } : {}),
        },
        threadId,
      })
    );
}

/** The desktop host's own executors, bound to its Main connection and thread. */
export function desktopHostToolExecutors(
  request: MainRequest,
  threadId: string
): Readonly<Record<string, NativeToolExecutor>> {
  return {
    ...CONTEXT_TOOL_EXECUTORS,
    ...INSPECTION_TOOL_EXECUTORS,
    [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(hostGrepIndex(request, threadId)),
    [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor(({ runtimeData }) =>
      hostShellCorrelation(request, threadId, runtimeData?.memory?.runId)
    ),
  };
}
