/**
 * The agent host's live native-tool fold for direct tool tests.
 *
 * `createSharedNativeHostTools` (host-capabilities) rebuilds, for every
 * Core-dispatched call, the Mastra tool for one id from
 * `{ ...SHARED_NATIVE_TOOL_EXECUTORS, ...desktopHostToolExecutors(...) }`
 * against that call's ports: Core's edit tracker, the thread's tool state
 * (task list and canvas) and, on Desktop, post-edit LSP diagnostics. Index
 * maintenance is absent: Desktop's canonical producer watches the files
 * itself. This helper performs the same fold once, so a suite drives the
 * exact executors and ports a host thread runs, without the HostTool binding
 * (guard + projection pipeline), which `agent-host-desktop-host-tools.test.ts`
 * covers through `desktopHostSharedTools`.
 */
import {
  getActiveToolResultBudget,
  type RuntimeData,
  type ScaledToolResultBudget,
} from '@brainstrike/agent';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import type {
  HostToolState,
  HostWorkspaceEdit,
  HostWorkspaceEditTracker,
} from '@brainstrike/agent-host';
import { LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import {
  hostCanvasStore,
  hostTaskListStore,
  type NativeToolBuildContext,
  type NativeToolExecutor,
  type NativeToolPorts,
  ReadWorkspaceFileCursorRegistry,
  SHARED_NATIVE_TOOL_EXECUTORS,
  type WebExtractToolDependencies,
  type WebSearchToolDependencies,
} from '@brainstrike/host-capabilities/native-tools';
import {
  desktopHostToolExecutors,
  type HostAppPaths,
} from '../../agent-host-platform/host-executed-tools';
import type { PlatformSelection } from '../../agent-host-platform/platform-wire';
import { getEditDiagnostics } from '../../assistant-server/lsp-diagnostics';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;
export type HostMainRequest = (
  method: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<unknown>;

/** Core's per-thread tool state, in memory: the same atomic per-key contract. */
export function memoryToolState(): HostToolState & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    entries: (prefix) => [...values].filter(([key]) => key.startsWith(prefix)),
    read: (key) => values.get(key),
    update: async (key, next) => {
      const value = next(values.get(key));
      if (value !== undefined) {
        values.set(key, value);
      }
    },
    values,
  };
}

/** Core's edit tracker reduced to its observable contract: run the mutation, record the edit. */
export function recordingEditTracker(): HostWorkspaceEditTracker & {
  readonly edits: HostWorkspaceEdit[];
} {
  const edits: HostWorkspaceEdit[] = [];
  return {
    edits,
    track: async (edit, mutate) => {
      try {
        return await mutate();
      } finally {
        edits.push(edit);
      }
    },
  };
}

/** A Main connection for suites whose tools never reach Main: any request fails loudly. */
export const unexpectedMainRequest: HostMainRequest = async (method) => {
  throw new Error(`Unexpected Main request ${method}`);
};

/** The admitted native runtime a host thread receives, derived from a test's RuntimeData. */
export function nativeRuntimeFor(
  runtimeData: RuntimeData,
  overrides: Partial<PlatformSelection['nativeRuntime']> = {}
): PlatformSelection['nativeRuntime'] {
  return {
    provider: typeof runtimeData.provider === 'string' ? runtimeData.provider : 'openai',
    workspaceRoots: (runtimeData.workspaceRoots ?? []).map(({ displayName, path, rootId }) => ({
      displayName,
      path,
      rootId,
    })),
    ...(runtimeData.workspaceRootPath ? { workspaceRootPath: runtimeData.workspaceRootPath } : {}),
    ...overrides,
  };
}

export interface HostNativeToolsOptions {
  readonly appPaths?: HostAppPaths;
  /**
   * Desktop's own executors beside the shared ones. Defaults to the live
   * `desktopHostToolExecutors` over `request`; a suite that injects one
   * capability passes the live executor factory for it instead.
   */
  readonly executors?: Readonly<Record<string, NativeToolExecutor>>;
  /** The executor ids to build; defaults to every shared and Desktop executor. */
  readonly ids?: readonly string[];
  readonly native?: PlatformSelection['nativeRuntime'];
  /** Overrides of the execution's ports; the rest are the host's (see the module note). */
  readonly ports?: Partial<NativeToolPorts>;
  readonly readFileCursorRegistry?: ReadWorkspaceFileCursorRegistry;
  readonly request?: HostMainRequest;
  readonly resolvedToolResultBudget?: ScaledToolResultBudget;
  readonly threadId?: string;
  readonly webExtract?: WebExtractToolDependencies;
  readonly webSearch?: WebSearchToolDependencies;
}

/** The execution ports `createSharedNativeHostTools` binds for one Core-dispatched call. */
export function hostExecutionPorts(overrides: Partial<NativeToolPorts> = {}): NativeToolPorts {
  const state = memoryToolState();
  return {
    artifactReader: undefined,
    canvas: hostCanvasStore(state),
    fileMutations: {
      diagnostics: (args) => getEditDiagnostics(args),
      edits: () => recordingEditTracker(),
    },
    taskList: hostTaskListStore(state),
    ...overrides,
  };
}

/** The live executor fold, keyed by catalog id, exactly as a host call binds it. */
export function buildHostNativeTools(
  runtimeData: RuntimeData,
  options: HostNativeToolsOptions = {}
): MastraTools {
  const threadId = options.threadId ?? runtimeData.memory?.threadId ?? 'host-thread';
  const executors: Readonly<Record<string, NativeToolExecutor>> = {
    ...SHARED_NATIVE_TOOL_EXECUTORS,
    ...(options.executors ??
      desktopHostToolExecutors(
        options.request ?? unexpectedMainRequest,
        threadId,
        options.native ?? nativeRuntimeFor(runtimeData),
        options.appPaths
      )),
  };
  const budget = options.resolvedToolResultBudget ?? CEILING_SCALED_TOOL_RESULT_BUDGET;
  const provider = typeof runtimeData.provider === 'string' ? runtimeData.provider : '';
  const context: NativeToolBuildContext = {
    isLocalProvider: provider.trim().toLowerCase() === 'local',
    ports: hostExecutionPorts(options.ports),
    readFileCursorRegistry: options.readFileCursorRegistry ?? new ReadWorkspaceFileCursorRegistry(),
    resolveActiveDomainCharBudget: () =>
      getActiveToolResultBudget()?.domainModelResultCharBudget ??
      budget.domainModelResultCharBudget,
    resolvedDomainCharBudget: budget.domainModelResultCharBudget,
    runtimeData,
    webExtract: options.webExtract,
    webSearch: options.webSearch,
  };
  const tools: MastraTools = {};
  for (const id of options.ids ?? Object.keys(executors)) {
    if (context.isLocalProvider && LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS.has(id)) {
      continue;
    }
    const executor = executors[id];
    if (!executor) {
      throw new Error(`No host executor is registered for native tool ${id}`);
    }
    const tool = executor(context);
    if (tool) {
      tools[id] = tool;
    }
  }
  return tools;
}
