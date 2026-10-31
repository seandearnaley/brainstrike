import { homedir } from 'node:os';
import type { FencedShell } from '@brainstrike/agent/fence-executor';
import type { HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID, scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import {
  type CommandSandbox,
  executeCommandExecutor,
  grepSearchExecutor,
  INSPECTION_TOOL_EXECUTORS,
  isSharedNativeToolId,
  type NativeToolExecutor,
  type ShellCorrelationDependencies,
} from '@brainstrike/host-capabilities/native-tools';
import {
  type BrowserToolRunner,
  browserToolExecutors,
} from '../assistant-server/native-tool-executors-browser';
import {
  CONTEXT_READ_TOOL_IDS,
  contextReadExecutors,
} from '../assistant-server/native-tool-executors-context';
import {
  type CodeExecutionHost,
  runPythonExecutor,
} from '../assistant-server/native-tool-executors-python';
import { retrievalToolExecutors } from '../assistant-server/native-tool-executors-retrieval';
import { selfInspectionExecutors } from '../assistant-server/native-tool-executors-self';
import { commandSessionExecutors } from '../assistant-server/native-tool-executors-sessions';
import {
  runSkillScriptExecutor,
  skillToolExecutors,
} from '../assistant-server/native-tool-executors-skills';
import { worktreeToolExecutors } from '../assistant-server/native-tool-executors-worktree';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import { admittedWorkspaceSkills } from '../assistant-server/request-skills';
import { createSecureSkillsFs } from '../assistant-server/skills-fs-deps';
import { nativeWorkspaceIndexSummary } from '../assistant-server/workspace-index-summary';
import {
  type DesktopWorktreeServices,
  desktopWorktreeToolDependencies,
} from '../assistant-server/worktree-tool-dependencies';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { resolvePythonBinary } from '../python-runtime/resolve-python-binary';
import {
  resolveDesktopPythonRuntimeInstallDir,
  resolveDesktopPythonRuntimeResourcesDir,
} from '../python-runtime/resources-dir';
import { resolveDesktopSeccompApplyPath } from '../sandbox-runtime-path';
import { hostIndexSearch, hostQueryEmbedding, hostRetrievalStore } from './host-retrieval-clients';
import { hostCommandSessionManager } from './host-tool-process';
import {
  BrowserActionResultSchema,
  BrowserNavigateResultSchema,
  BrowserPageTextResultSchema,
  BrowserReadPageResultSchema,
  BrowserSelectOptionResultSchema,
  DiagnosticEventItemsSchema,
  DiagnosticFingerprintItemsSchema,
} from './host-tool-wire';
import type { PlatformSelection } from './platform-wire';

/** Desktop tools the agent host runs in its own process beside the shared ones. */
const DESKTOP_HOST_TOOL_IDS: ReadonlySet<string> = new Set([
  ...CONTEXT_READ_TOOL_IDS,
  NATIVE_TOOL_ID.queryDiagnostics,
  ...Object.keys(INSPECTION_TOOL_EXECUTORS),
  NATIVE_TOOL_ID.executeCommand,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
  NATIVE_TOOL_ID.listWorktrees,
  NATIVE_TOOL_ID.manageWorktree,
  NATIVE_TOOL_ID.browserClick,
  NATIVE_TOOL_ID.browserGetPageText,
  NATIVE_TOOL_ID.browserNavigate,
  NATIVE_TOOL_ID.browserReadPage,
  NATIVE_TOOL_ID.browserSelectOption,
  NATIVE_TOOL_ID.browserType,
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
 * A host command's worktree correlation over the host's own worktree
 * ledger: the pre-command path snapshot, then the completed command under the
 * host run's identity. Neither ever blocks the command; the reconcile fails
 * closed to "adopt nothing" without a snapshot.
 */
function hostShellCorrelation(
  services: DesktopWorktreeServices,
  threadId: string,
  runId: string | undefined,
  shellWorktrees: HostToolContext['shellWorktrees']
): ShellCorrelationDependencies {
  const { shellCorrelation, worktreeTools } = desktopWorktreeToolDependencies(services, {
    runId,
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
              shellWorktrees?.(adopted);
            },
          },
        }
      : {}),
    ...(worktreeTools ? { worktreeTools } : {}),
  };
}

/** The browser pane is window-bound: Main drives it for the host's call. */
function hostBrowserTools(request: MainRequest, threadId: string): BrowserToolRunner {
  return {
    click: async (input, signal) =>
      wireDecoder(BrowserActionResultSchema, { errors: 'all' })(
        await request('platform/browser/click', { input, threadId }, signal)
      ),
    getPageText: async (input, signal) =>
      wireDecoder(BrowserPageTextResultSchema, { errors: 'all' })(
        await request('platform/browser/page-text', { input, threadId }, signal)
      ),
    navigate: async (input, signal) =>
      wireDecoder(BrowserNavigateResultSchema, { errors: 'all' })(
        await request('platform/browser/navigate', { input, threadId }, signal)
      ),
    readPage: async (input, signal) =>
      wireDecoder(BrowserReadPageResultSchema, { errors: 'all' })(
        await request('platform/browser/read-page', { input, threadId }, signal)
      ),
    selectOption: async (input, signal) =>
      wireDecoder(BrowserSelectOptionResultSchema, { errors: 'all' })(
        await request('platform/browser/select-option', { input, threadId }, signal)
      ),
    type: async (input, signal) =>
      wireDecoder(BrowserActionResultSchema, { errors: 'all' })(
        await request('platform/browser/type', { input, threadId }, signal)
      ),
  };
}

/** A validated context write-back reaches the app windows only through Main. */
/** The diagnostics store stays Main's; its rows arrive projected and scrubbed. */
function hostDiagnosticsReader(request: MainRequest, threadId: string): DiagnosticsReader {
  return {
    events: async (filter) =>
      wireDecoder(DiagnosticEventItemsSchema, { errors: 'all' })(
        await request('desktop-read/diagnostics/events', { filter, threadId })
      ),
    fingerprints: async (filter) =>
      wireDecoder(DiagnosticFingerprintItemsSchema, { errors: 'all' })(
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

/** The bundled interpreter and sandbox helper the launching app ships, from its launch facts. */
function hostCodeExecution(appPaths: HostAppPaths): CodeExecutionHost {
  return {
    resolvePythonExecutable: async (signal) => {
      const manifestDir = resolveDesktopPythonRuntimeResourcesDir(
        appPaths.isPackaged,
        appPaths.resourcesPath
      );
      return await resolvePythonBinary({
        installDir: resolveDesktopPythonRuntimeInstallDir(
          appPaths.isPackaged,
          manifestDir,
          process.platform,
          process.arch
        ),
        manifestDir,
        signal,
      });
    },
    resolveSeccompApplyPath: () =>
      resolveDesktopSeccompApplyPath(appPaths.isPackaged, appPaths.resourcesPath),
  };
}

/**
 * The OS sandbox this host's commands run in (BST-2328): one per process,
 * since the fence's session is process-global and holds itself for the
 * process's life. Imported lazily, as run_python's fence is, so building the
 * tool map never loads sandbox-runtime.
 */
let commandSandbox: Promise<FencedShell | undefined> | undefined;
function hostCommandSandbox(appPaths: HostAppPaths | undefined): CommandSandbox {
  return () => {
    commandSandbox ??= import('@brainstrike/agent/fence-executor').then(({ createFencedShell }) => {
      // Without launch facts there is no packaged helper to name, and
      // sandbox-runtime finds its own: a dev checkout, as run_python's fence.
      const linuxSeccompApplyPath = appPaths
        ? hostCodeExecution(appPaths).resolveSeccompApplyPath()
        : undefined;
      return createFencedShell(
        linuxSeccompApplyPath === undefined ? {} : { linuxSeccompApplyPath }
      );
    });
    return commandSandbox;
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
  /** The host's worktree services, which each run borrows under its own identity. */
  worktrees: DesktopWorktreeServices,
  threadId: string,
  /** The run's admitted native runtime: its roots, retrieval scope and skills. */
  native: PlatformSelection['nativeRuntime'],
  /** Absent without a launching desktop; then run_python has no interpreter here. */
  appPaths?: HostAppPaths
): Readonly<Record<string, NativeToolExecutor>> {
  const retrievalRootsOnly = native.retrievalRootsOnly === true;
  const nativeIndexSearch = hostIndexSearch(request, threadId);
  const queryEmbedder = hostQueryEmbedding(request);
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
        nativeIndexSearch,
        queryEmbedder,
      },
      store,
    })),
    ...contextReadExecutors(async () =>
      nativeWorkspaceIndexSummary(await nativeIndexSearch.status())
    ),
    ...INSPECTION_TOOL_EXECUTORS,
    [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(),
    ...browserToolExecutors(hostBrowserTools(request, threadId)),
    ...commandSessionExecutors(() => ({
      manager: hostCommandSessionManager(),
      rootsFromRuntime: true,
    })),
    ...selfInspectionExecutors(hostDiagnosticsReader(request, threadId)),
    ...worktreeToolExecutors(
      ({ runtimeData }) =>
        desktopWorktreeToolDependencies(worktrees, {
          runId: runtimeData?.memory?.runId,
          threadId,
        }).worktreeTools
    ),
    ...(appPaths
      ? { [NATIVE_TOOL_ID.runPython]: runPythonExecutor(hostCodeExecution(appPaths)) }
      : {}),
    ...hostSkillExecutors(native, appPaths),
    [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor({
      correlation: ({ ports, runtimeData }) =>
        hostShellCorrelation(worktrees, threadId, runtimeData?.memory?.runId, ports.shellWorktrees),
      sandbox: hostCommandSandbox(appPaths),
      // Desktop's own bundled wrapper, emitted beside this host bundle.
      windowsCommandEntry: () =>
        resolveBundledSiblingPath('Windows command', 'windows-command-entry.cjs'),
    }),
  };
}
