import {
  forgetFileReadScope,
  getActiveToolResultBudget,
  type RuntimeData,
  type RuntimeWorkspaceRoot,
  type ScaledToolResultBudget,
} from '@brainstrike/agent';
import {
  createAgentHostToolBindings,
  type HostTool,
  type HostToolContext,
} from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID, resolveToolRiskCategory } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import {
  type MastraTool,
  type MastraTools,
  type NativeToolBuildContext,
  type NativeToolPorts,
  SHARED_NATIVE_TOOL_EXECUTORS,
  SHARED_NATIVE_TOOL_IDS,
  type SharedNativeToolId,
} from './executors.js';
import { hostCanvasStore, hostTaskListNote, hostTaskListStore } from './host-stores.js';
import type { FileMutationPorts } from './ports.js';
import type { ReadWorkspaceFileCursorRegistry } from './read-workspace-file-cursor-registry.js';
import { resetToolCallLoopGuards } from './tool-call-loop-guards.js';
import type { WebExtractToolDependencies } from './web-extract-tool.js';
import type { WebSearchToolDependencies } from './web-search-tool.js';

/**
 * Purge a deleted thread's process-local tool state: its read cursors, its
 * read-before-write observations and its loop-guard streaks.
 */
export function forgetSharedNativeToolThread(
  threadId: string,
  readFileCursorRegistry: ReadWorkspaceFileCursorRegistry
): void {
  readFileCursorRegistry.forgetThread(threadId);
  forgetFileReadScope(threadId);
  resetToolCallLoopGuards(threadId);
}

export function isSharedNativeToolId(id: string): id is SharedNativeToolId {
  return (SHARED_NATIVE_TOOL_IDS as readonly string[]).includes(id);
}

/** One request-scoped executor entry over the shared build context. */
export type NativeToolExecutor = (context: NativeToolBuildContext) => MastraTool | undefined;

export interface SharedNativeHostToolsOptions {
  /** Post-edit language-server diagnostics the shell can run in this process. */
  readonly diagnostics?: FileMutationPorts['diagnostics'];
  /**
   * A shell's own in-process executors beside the shared ones (Desktop's
   * language-server inspection); each id in `ids` needs one or the other.
   */
  readonly executors?: Readonly<Record<string, NativeToolExecutor>>;
  /**
   * The live roots before each execution and the recheck after it; absent
   * keeps the admitted roots. A revoked root rejects the call.
   */
  readonly freshRoots?: (signal: AbortSignal) => Promise<readonly RuntimeWorkspaceRoot[]>;
  /** The admitted host-executed tools, by canonical catalog id. */
  readonly ids: readonly string[];
  /** One host-lifetime registry; its handles are scoped to the calling thread. */
  readonly readFileCursorRegistry: ReadWorkspaceFileCursorRegistry;
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /** The admitted request runtime, without per-execution memory identity. */
  readonly runtime: RuntimeData;
  /** This process's Tavily key owner; required when web search is admitted. */
  /** The host's Tavily key owner for web extract; absent omits it. */
  readonly webExtract?: WebExtractToolDependencies;
  readonly webSearch?: WebSearchToolDependencies;
}

function unavailableAtAdmission(): never {
  throw new Error('Shared native tools execute only inside a Core-dispatched call');
}

/** Ports bound to one Core-dispatched execution: its edit tracker and thread state. */
function executionPorts(
  context: HostToolContext,
  diagnostics: FileMutationPorts['diagnostics']
): NativeToolPorts {
  const { edits, state } = context;
  if (!(edits && state)) {
    throw new Error('Core supplied no edit or state capability to a shared native tool');
  }
  return {
    artifactReader: context.artifacts,
    canvas: hostCanvasStore(state),
    fileMutations: { ...(diagnostics ? { diagnostics } : {}), edits: () => edits },
    taskList: hostTaskListStore(state),
  };
}

/**
 * The shared native tools as Core host tools, executed in this process, keyed
 * by their provider tool names (`permissionToolId` is the catalog id). Each
 * call rebuilds its executor against the call's own ports, memory identity and
 * live roots, and refuses an executor whose identity changed since admission.
 */
export function createSharedNativeHostTools(
  options: SharedNativeHostToolsOptions
): Readonly<Record<string, HostTool>> {
  const budget = options.resolvedToolResultBudget.domainModelResultCharBudget;
  const provider = typeof options.runtime.provider === 'string' ? options.runtime.provider : '';
  const executors: Readonly<Record<string, NativeToolExecutor>> = {
    ...SHARED_NATIVE_TOOL_EXECUTORS,
    ...options.executors,
  };
  const bind = (runtimeData: RuntimeData, ports: NativeToolPorts) => {
    const context: NativeToolBuildContext = {
      isLocalProvider: provider.trim().toLowerCase() === 'local',
      ports,
      readFileCursorRegistry: options.readFileCursorRegistry,
      resolveActiveDomainCharBudget: () =>
        getActiveToolResultBudget()?.domainModelResultCharBudget ?? budget,
      resolvedDomainCharBudget: budget,
      runtimeData,
      webExtract: options.webExtract,
      webSearch: options.webSearch,
    };
    const tools: MastraTools = {};
    for (const id of options.ids) {
      const executor = executors[id];
      if (!executor) {
        throw new Error(`No host executor is registered for native tool ${id}`);
      }
      const tool = executor(context);
      if (tool) {
        tools[id] = tool;
      }
    }
    return createAgentHostToolBindings({
      bindings: Object.fromEntries(
        Object.keys(tools).map((id) => {
          const definition =
            NATIVE_TOOL_REGISTRIES.byId[id as keyof typeof NATIVE_TOOL_REGISTRIES.byId];
          return [id, { identity: id, risk: resolveToolRiskCategory(definition.defaults) }];
        })
      ),
      resolvedToolResultBudget: options.resolvedToolResultBudget,
      tools,
    });
  };
  const admitted = bind(options.runtime, {
    // The reader is admitted; Core supplies the thread's reader to each call.
    artifactReader: { readRange: unavailableAtAdmission },
    canvas: undefined,
    fileMutations: { edits: unavailableAtAdmission },
    taskList: undefined,
  });
  const byCanonicalId = new Map(
    [...admitted.toolNameMap].map(([name, canonicalId]) => [canonicalId, name] as const)
  );
  const tools: Record<string, HostTool> = {};
  for (const id of options.ids) {
    const name = byCanonicalId.get(id);
    const tool = name === undefined ? undefined : admitted.tools[name];
    if (!(name && tool)) {
      throw new Error(`Shared native tool ${id} is unavailable for this request`);
    }
    tools[name] = {
      ...tool,
      ...(id === NATIVE_TOOL_ID.manageTaskList ? { contextNote: hostTaskListNote } : {}),
      execute: async (input: unknown, context: HostToolContext): Promise<unknown> => {
        context.signal.throwIfAborted();
        const roots = options.freshRoots
          ? [...(await options.freshRoots(context.signal))]
          : options.runtime.workspaceRoots;
        context.signal.throwIfAborted();
        const executor = bind(
          {
            ...options.runtime,
            memory: {
              resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
              runId: context.runId,
              threadId: context.threadId,
            },
            ...(roots ? { workspaceRoots: roots } : {}),
          },
          executionPorts(context, options.diagnostics)
        ).tools[name];
        if (!executor || executor.identity !== tool.identity) {
          throw new Error('Shared native executor changed after admission');
        }
        const result = await executor.execute(input, context);
        if (options.freshRoots) {
          await options.freshRoots(context.signal);
          context.signal.throwIfAborted();
        }
        return result;
      },
    };
  }
  return tools;
}
