import { homedir } from 'node:os';
import type { HostToolContext } from '@brainstrike/agent-host';
import {
  NATIVE_TOOL_ID,
  scanShellCommandForGitSignals,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import {
  isSharedNativeToolId,
  type NativeToolExecutor,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import type { ShellCorrelationDependencies } from '../assistant-server/execute-command-correlation';
import type { GrepIndexSearch } from '../assistant-server/grep-search-core';
import {
  type BrowserToolRunner,
  browserToolExecutors,
} from '../assistant-server/native-tool-executors-browser';
import {
  CONTEXT_TOOL_EXECUTORS,
  contextWriteExecutors,
} from '../assistant-server/native-tool-executors-context';
import { grepSearchExecutor } from '../assistant-server/native-tool-executors-grep';
import { INSPECTION_TOOL_EXECUTORS } from '../assistant-server/native-tool-executors-inspection';
import {
  type CodeExecutionHost,
  runPythonExecutor,
} from '../assistant-server/native-tool-executors-python';
import { retrievalToolExecutors } from '../assistant-server/native-tool-executors-retrieval';
import { selfInspectionExecutors } from '../assistant-server/native-tool-executors-self';
import { commandSessionExecutors } from '../assistant-server/native-tool-executors-sessions';
import { executeCommandExecutor } from '../assistant-server/native-tool-executors-shell';
import {
  runSkillScriptExecutor,
  skillToolExecutors,
} from '../assistant-server/native-tool-executors-skills';
import { worktreeToolExecutors } from '../assistant-server/native-tool-executors-worktree';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import {
  QUERY_SELF_ERROR_MESSAGES,
  type QuerySelfRead,
  type QuerySelfResult,
} from '../assistant-server/query-self-core';
import { admittedWorkspaceSkills } from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import type { WorkspaceContextBroadcaster } from '../assistant-server/workspace-context-tools';
import type { WorktreeToolCapability } from '../assistant-server/worktree-tools';
import { resolvePythonBinary } from '../python-runtime/resolve-python-binary';
import { resolveDesktopPythonRuntimeResourcesDir } from '../python-runtime/resources-dir';
import { resolveDesktopSeccompApplyPath } from '../sandbox-runtime-path';
import { hostIndexSearch, hostQueryEmbedding, hostRetrievalStore } from './host-retrieval-clients';
import { hostCommandSessionManager } from './host-tool-process';
import {
  BrowserNavigateResultSchema,
  BrowserPageTextResultSchema,
  BrowserReadPageResultSchema,
  ContextDeliveryResultSchema,
  DiagnosticEventItemsSchema,
  DiagnosticFingerprintItemsSchema,
  GrepIndexResultSchema,
  PlatformShellCompletedResultSchema,
  QuerySelfReadResultSchema,
  WorktreeArchiveResultSchema,
  WorktreeCreateResultSchema,
  WorktreeListResultSchema,
  WorktreePathsResultSchema,
} from './host-tool-wire';
import type { PlatformSelection } from './platform-wire';

const logger = createLogger('DesktopHostTools');

/** Desktop tools the agent host runs in its own process beside the shared ones. */
const DESKTOP_HOST_TOOL_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(CONTEXT_TOOL_EXECUTORS),
  NATIVE_TOOL_ID.updateWorkspaceContextSelection,
  NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
  NATIVE_TOOL_ID.queryDiagnostics,
  NATIVE_TOOL_ID.querySelf,
  ...Object.keys(INSPECTION_TOOL_EXECUTORS),
  NATIVE_TOOL_ID.executeCommand,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
  NATIVE_TOOL_ID.listWorktrees,
  NATIVE_TOOL_ID.manageWorktree,
  NATIVE_TOOL_ID.browserGetPageText,
  NATIVE_TOOL_ID.browserNavigate,
  NATIVE_TOOL_ID.browserReadPage,
  NATIVE_TOOL_ID.runPython,
  NATIVE_TOOL_ID.inspectCommandSessions,
  NATIVE_TOOL_ID.manageCommandSession,
  NATIVE_TOOL_ID.runSkillScript,
  'skill',
  'skill_read',
  'skill_search',
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
  runId: string | undefined,
  shellWorktrees: HostToolContext['shellWorktrees']
): ShellCorrelationDependencies {
  return {
    shellCorrelation: {
      onCommandCompleted: ({ command, precedingWorktreePaths, rootId }) => {
        // Only a git-worktree or PR-creating command has anything for Main to correlate.
        const signals = scanShellCommandForGitSignals(command);
        if (!(signals.touchedWorktrees || signals.createdPullRequest)) {
          return;
        }
        const adopted = request('platform/shell/completed', {
          command,
          precedingWorktreePaths: precedingWorktreePaths ? [...precedingWorktreePaths] : null,
          rootId,
          ...(runId ? { runId } : {}),
          threadId,
        })
          .then((reply) => PlatformShellCompletedResultSchema.parse(reply).adopted)
          .catch((error: unknown) => {
            logger.error('shell correlation request failed', { error, rootId });
            return [];
          });
        // Core commits each adopted worktree under this call, joined by its run.
        shellWorktrees?.(adopted);
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

/** Main's worktree service for one host run, until the worktree ledger is a host fact. */
function hostWorktreeTools(
  request: MainRequest,
  threadId: string,
  runId: string | undefined
): WorktreeToolCapability {
  const run = { ...(runId ? { runId } : {}), threadId };
  return {
    archive: async (params) =>
      WorktreeArchiveResultSchema.parse(
        await request('platform/worktree/archive', { ...run, params })
      ),
    create: async (params) =>
      WorktreeCreateResultSchema.parse(
        await request('platform/worktree/create', { ...run, params })
      ),
    list: async () =>
      WorktreeListResultSchema.parse(await request('platform/worktree/list', { threadId })),
  };
}

/** The browser pane is window-bound: Main drives it for the host's call. */
function hostBrowserTools(request: MainRequest, threadId: string): BrowserToolRunner {
  return {
    getPageText: async (input, signal) =>
      BrowserPageTextResultSchema.parse(
        await request('platform/browser/page-text', { input, threadId }, signal)
      ),
    navigate: async (input, signal) =>
      BrowserNavigateResultSchema.parse(
        await request('platform/browser/navigate', { input, threadId }, signal)
      ),
    readPage: async (input, signal) =>
      BrowserReadPageResultSchema.parse(
        await request('platform/browser/read-page', { input, threadId }, signal)
      ),
  };
}

/** A validated context write-back reaches the app windows only through Main. */
function hostContextDelivery(request: MainRequest, threadId: string): WorkspaceContextBroadcaster {
  return {
    selection: async (payload) =>
      ContextDeliveryResultSchema.parse(
        await request('platform/workspace-context/selection', { payload, threadId })
      ).notifiedWindowCount,
    tapestry: async (payload) =>
      ContextDeliveryResultSchema.parse(
        await request('platform/workspace-context/tapestry', { payload, threadId })
      ).notifiedWindowCount,
  };
}

/** querySelf's SQL runs in Main's sandboxed role or index process; only its outcome crosses. */
function hostQuerySelfRead(request: MainRequest, threadId: string): QuerySelfRead {
  return async (read, signal) => {
    const outcome = QuerySelfReadResultSchema.parse(
      await request('desktop-read/query-self', { request: read, threadId }, signal)
    );
    if (outcome.ok) {
      return outcome.result satisfies QuerySelfResult;
    }
    throw outcome.error === 'input'
      ? new ToolInputError(outcome.message)
      : new Error(QUERY_SELF_ERROR_MESSAGES.queryFailed);
  };
}

/** The diagnostics store stays Main's; its rows arrive projected and scrubbed. */
function hostDiagnosticsReader(request: MainRequest, threadId: string): DiagnosticsReader {
  return {
    events: async (filter) =>
      DiagnosticEventItemsSchema.parse(
        await request('desktop-read/diagnostics/events', { filter, threadId })
      ),
    fingerprints: async (filter) =>
      DiagnosticFingerprintItemsSchema.parse(
        await request('desktop-read/diagnostics/fingerprints', { filter, threadId })
      ),
  };
}

/** The launching desktop app's facts, from the host's launch options. */
export interface HostAppPaths {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly userDataPath: string;
}

/** The same bundled interpreter and sandbox helper Main resolves, from the launch facts. */
function hostCodeExecution(appPaths: HostAppPaths): CodeExecutionHost {
  return {
    resolvePythonExecutable: (signal) =>
      resolvePythonBinary({
        resourcesDir: resolveDesktopPythonRuntimeResourcesDir(
          appPaths.isPackaged,
          appPaths.resourcesPath
        ),
        signal,
        userDataDir: appPaths.userDataPath,
      }),
    resolveSeccompApplyPath: () =>
      resolveDesktopSeccompApplyPath(appPaths.isPackaged, appPaths.resourcesPath),
  };
}

/**
 * The skills Main admitted for this run, never rescanned here: their
 * references, scripts and assets are read through this host's own secure fs.
 */
function hostSkillExecutors(
  native: PlatformSelection['nativeRuntime'],
  appPaths: HostAppPaths | undefined
): Readonly<Record<string, NativeToolExecutor>> {
  if (!native.skills) {
    return {};
  }
  const skills = admittedWorkspaceSkills(
    native.skills,
    createSecureSkillsFs([...native.workspaceRoots.map((root) => root.path), homedir()])
  );
  return {
    ...skillToolExecutors(skills),
    ...(appPaths
      ? {
          [NATIVE_TOOL_ID.runSkillScript]: runSkillScriptExecutor(
            skills,
            hostCodeExecution(appPaths).resolvePythonExecutable
          ),
        }
      : {}),
  };
}

/** The desktop host's own executors, bound to its Main connection and thread. */
export function desktopHostToolExecutors(
  request: MainRequest,
  threadId: string,
  /** The run's admitted native runtime: its roots, retrieval scope and skills. */
  native: PlatformSelection['nativeRuntime'],
  /** Absent without a launching desktop; then run_python has no interpreter here. */
  appPaths?: HostAppPaths
): Readonly<Record<string, NativeToolExecutor>> {
  const retrievalRootsOnly = native.retrievalRootsOnly === true;
  const nativeIndexSearch = hostIndexSearch(request, threadId);
  const embeddingHostManager = hostQueryEmbedding(request);
  const store = hostRetrievalStore(request, threadId);
  return {
    ...retrievalToolExecutors(({ runtimeData }) => ({
      dependencies: {
        ...(retrievalRootsOnly
          ? {
              admittedWorkspaceRootIds: (runtimeData?.workspaceRoots ?? []).map(
                (root) => root.rootId
              ),
            }
          : {}),
        embeddingHostManager,
        nativeIndexSearch,
      },
      store,
    })),
    ...CONTEXT_TOOL_EXECUTORS,
    ...contextWriteExecutors(hostContextDelivery(request, threadId)),
    ...INSPECTION_TOOL_EXECUTORS,
    [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(hostGrepIndex(request, threadId)),
    ...browserToolExecutors(hostBrowserTools(request, threadId)),
    ...commandSessionExecutors(() => ({
      manager: hostCommandSessionManager(),
      rootsFromRuntime: true,
    })),
    ...selfInspectionExecutors(
      hostQuerySelfRead(request, threadId),
      hostDiagnosticsReader(request, threadId)
    ),
    ...worktreeToolExecutors(({ runtimeData }) =>
      hostWorktreeTools(request, threadId, runtimeData?.memory?.runId)
    ),
    ...(appPaths
      ? { [NATIVE_TOOL_ID.runPython]: runPythonExecutor(hostCodeExecution(appPaths)) }
      : {}),
    ...hostSkillExecutors(native, appPaths),
    [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor(({ ports, runtimeData }) =>
      hostShellCorrelation(request, threadId, runtimeData?.memory?.runId, ports.shellWorktrees)
    ),
  };
}
