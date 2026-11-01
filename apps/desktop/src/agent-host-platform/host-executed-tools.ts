import { homedir } from 'node:os';
import type { FencedShell } from '@brainstrike/agent/fence-executor';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import {
  commandSessionExecutors,
  hostCommandSessionManager,
} from '@brainstrike/host-capabilities/command-sessions';
import {
  type HostWorktreeServices,
  hostShellCorrelation,
  hostWorktreeToolExecutors,
} from '@brainstrike/host-capabilities/git-workspace';
import {
  CONTEXT_READ_TOOL_IDS,
  type CodeExecutionHost,
  type CommandSandbox,
  contextReadExecutors,
  executeCommandExecutor,
  grepSearchExecutor,
  INSPECTION_TOOL_EXECUTORS,
  isSharedNativeToolId,
  type NativeToolExecutor,
  runPythonExecutor,
  runSkillScriptExecutor,
  skillToolExecutors,
} from '@brainstrike/host-capabilities/native-tools';
import {
  admittedWorkspaceSkills,
  createSecureSkillsFs,
} from '@brainstrike/host-capabilities/workspace-context';
import {
  type BrowserToolRunner,
  browserToolExecutors,
} from '../assistant-server/native-tool-executors-browser';
import { selfInspectionExecutors } from '../assistant-server/native-tool-executors-self';
import type { DiagnosticsReader } from '../assistant-server/query-diagnostics-core';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';
import { resolvePythonBinary } from '../python-runtime/resolve-python-binary';
import {
  resolveDesktopPythonRuntimeInstallDir,
  resolveDesktopPythonRuntimeResourcesDir,
} from '../python-runtime/resources-dir';
import { resolveDesktopSeccompApplyPath } from '../sandbox-runtime-path';
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

/** Desktop's own bundled Windows command wrapper, emitted beside this host bundle. */
const desktopWindowsCommandEntry = (): string =>
  resolveBundledSiblingPath('Windows command', 'windows-command-entry.cjs');

/** The launching desktop app's facts, from the host's launch options. */
export interface HostAppPaths {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly userDataPath: string;
}

/** The bundled interpreter, sandbox helper and Windows wrapper the launching app ships. */
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
    windowsCommandEntry: desktopWindowsCommandEntry,
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
 * The skills this run's admission scanned, never rescanned here: their
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
            hostCodeExecution(appPaths)
          ),
        }
      : {}),
  };
}

/** The desktop host's own executors, bound to its Main connection and thread. */
export function desktopHostToolExecutors(
  request: MainRequest,
  /** The host's worktree services, which each run borrows under its own identity. */
  worktrees: HostWorktreeServices,
  threadId: string,
  /** The run's admitted native runtime: its roots and skills. */
  native: PlatformSelection['nativeRuntime'],
  /** Absent without a launching desktop; then run_python has no interpreter here. */
  appPaths?: HostAppPaths
): Readonly<Record<string, NativeToolExecutor>> {
  return {
    ...contextReadExecutors(),
    ...INSPECTION_TOOL_EXECUTORS,
    [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(),
    ...browserToolExecutors(hostBrowserTools(request, threadId)),
    ...commandSessionExecutors(() => ({
      manager: hostCommandSessionManager(),
      rootsFromRuntime: true,
    })),
    ...selfInspectionExecutors(hostDiagnosticsReader(request, threadId)),
    ...hostWorktreeToolExecutors(worktrees, threadId),
    ...(appPaths
      ? { [NATIVE_TOOL_ID.runPython]: runPythonExecutor(hostCodeExecution(appPaths)) }
      : {}),
    ...hostSkillExecutors(native, appPaths),
    [NATIVE_TOOL_ID.executeCommand]: executeCommandExecutor({
      correlation: hostShellCorrelation(worktrees, threadId),
      sandbox: hostCommandSandbox(appPaths),
      windowsCommandEntry: desktopWindowsCommandEntry,
    }),
  };
}
