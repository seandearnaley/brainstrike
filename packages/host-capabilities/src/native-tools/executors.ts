/**
 * The native tools every host executes in its own process (desktop host,
 * standalone CLI) — and that Desktop's legacy assistant server still runs for
 * legacy threads. Each entry builds one catalog definition's request-scoped
 * Mastra registry object from the shell-supplied ports; the shells fold these
 * entries into their own executor maps.
 */
import {
  createAskUserTool,
  createSubmitPlanTool,
  type DeleteWorkspaceFileInput,
  type ManageCanvasInput,
  type ManageTaskListInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  normalizeManageCanvasInput,
  type ReadToolOutputArtifactCursorInput,
  type ReadWorkspaceDirectoryInput,
  type ReadWorkspaceFileInput,
  type RenameWorkspaceFileInput,
  type RuntimeData,
  readToolExecutionThreadId,
  type StringReplaceWorkspaceFileInput,
  type WebExtractInput,
  type WebSearchInput,
  type WriteWorkspaceFileInput,
} from '@brainstrike/agent';
import {
  readToolOutputArtifact,
  type ScopedToolOutputArtifactReader,
} from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { createArtifactReaderModelProjection } from './artifact-reader-model-projection.js';
import { SEARCH_NATIVE_TOOL_EXECUTORS } from './executors-search.js';
import {
  runDeleteWorkspaceFile,
  runRenameWorkspaceFile,
  runStringReplaceWorkspaceFile,
  runWriteWorkspaceFile,
} from './file-mutation-tools.js';
import { runManageCanvas } from './manage-canvas-tool.js';
import { runManageTaskList } from './manage-task-list-tool.js';
import type { CanvasStore, FileMutationPorts, TaskListStore } from './ports.js';
import { runReadWorkspaceDirectory } from './read-workspace-directory-tool.js';
import type { ReadWorkspaceFileCursorRegistry } from './read-workspace-file-cursor-registry.js';
import { projectReadWorkspaceFileModelOutput } from './read-workspace-file-model-projection.js';
import { runReadWorkspaceFile } from './read-workspace-file-tool.js';
import {
  logToolFailure,
  parseToolExecuteInput,
  readToolCallId,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from './tool-execute-support.js';
import { projectWebExtractModelOutput } from './web-extract-model-projection.js';
import { runWebExtract, type WebExtractToolDependencies } from './web-extract-tool.js';
import { projectWebSearchModelOutput } from './web-search-model-projection.js';
import { runWebSearch, type WebSearchToolDependencies } from './web-search-tool.js';
import { readStateScope } from './workspace-file-staleness.js';

export type MastraTools = NonNullable<RuntimeData['mastraTools']>;
export type MastraTool = MastraTools[string];

/** The thread-scoped stores and edit owner one request's shared tools write through. */
export interface NativeToolPorts {
  /**
   * This request's durable tool-output artifacts; absent when it settles none,
   * and the artifact reader then omits itself.
   */
  readonly artifactReader: ScopedToolOutputArtifactReader | undefined;
  /** Absent without an active thread; the tool then reports `no_active_thread`. */
  readonly canvas: CanvasStore | undefined;
  readonly fileMutations: FileMutationPorts;
  /** Absent without an active thread; the tool then reports it. */
  readonly taskList: TaskListStore | undefined;
}

/** What one request hands every shared executor entry. */
export interface NativeToolBuildContext {
  /**
   * True when the request targets the built-in on-device provider. The
   * entries that omit themselves for it (task list, suspending tools, canvas)
   * say why beside their own gate.
   */
  readonly isLocalProvider: boolean;
  readonly ports: NativeToolPorts;
  readonly readFileCursorRegistry: ReadWorkspaceFileCursorRegistry;
  /** The live per-call domain budget, falling back to the request's resolved one. */
  readonly resolveActiveDomainCharBudget: () => number;
  readonly resolvedDomainCharBudget: number;
  readonly runtimeData: RuntimeData | undefined;
  /** The process's Tavily key owner for web extract; absent omits it for the request. */
  readonly webExtract?: WebExtractToolDependencies | undefined;
  /** The process's Tavily key owner; absent omits web search for the request. */
  readonly webSearch?: WebSearchToolDependencies | undefined;
}

export const SHARED_NATIVE_TOOL_IDS = [
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.findWorkspaceSymbol,
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.manageCanvas,
  NATIVE_TOOL_ID.manageTaskList,
  NATIVE_TOOL_ID.readToolOutputArtifact,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.submitPlan,
  NATIVE_TOOL_ID.webExtract,
  NATIVE_TOOL_ID.webSearch,
  NATIVE_TOOL_ID.writeWorkspaceFile,
] as const;
export type SharedNativeToolId = (typeof SHARED_NATIVE_TOOL_IDS)[number];

export type SharedNativeToolExecutors = {
  readonly [Id in SharedNativeToolId]: (context: NativeToolBuildContext) => MastraTool | undefined;
};

export const SHARED_NATIVE_TOOL_EXECUTORS: SharedNativeToolExecutors = {
  ...SEARCH_NATIVE_TOOL_EXECUTORS,
  [NATIVE_TOOL_ID.readWorkspaceFile]: ({
    readFileCursorRegistry,
    resolveActiveDomainCharBudget,
    resolvedDomainCharBudget,
    runtimeData,
  }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<ReadWorkspaceFileInput>,
      context?: ToolExecuteContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
        input
      );
      try {
        // BST-1188: readWorkspaceFile deliberately does NOT use the plain
        // identical-args repeated-call guard (`withRepeatedCallGuard`)
        // other read/search tools use — an args-only streak has no
        // way to know the file changed between calls, so it would either
        // permanently refuse a legitimate re-read after an edit (the
        // refusal short-circuits BEFORE the file is ever checked) or stamp
        // a "results have not changed" warning on content that in fact did
        // change (PR #2323 review). The mtime-aware `readWorkspaceFile`
        // loop guard below is the ONLY mechanism — it always re-reads the
        // file first, so it can never go stale in that way.
        return await runReadWorkspaceFile(resolvedInput, runtimeData, readFileCursorRegistry, {
          domainModelResultCharBudget: resolvedDomainCharBudget,
          threadScope: readToolExecutionThreadId([input, context]) ?? readStateScope(runtimeData),
        });
      } catch (error) {
        logToolFailure('readWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
    toModelOutput: (output: unknown) =>
      projectReadWorkspaceFileModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.readToolOutputArtifact]: ({ ports, resolveActiveDomainCharBudget }) => {
    const reader = ports.artifactReader;
    if (!reader) {
      return;
    }
    return {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readToolOutputArtifact],
      execute: async (input: ToolExecuteInput<ReadToolOutputArtifactCursorInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
          input
        );
        try {
          return await readToolOutputArtifact({ ...resolvedInput, mode: 'cursor' }, { reader });
        } catch (error) {
          logToolFailure('readToolOutputArtifact failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.readToolOutputArtifact,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
      toModelOutput: createArtifactReaderModelProjection(resolveActiveDomainCharBudget),
    };
  },
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: ({ runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceDirectory],
    execute: async (input: ToolExecuteInput<ReadWorkspaceDirectoryInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
        input
      );
      try {
        return await runReadWorkspaceDirectory(resolvedInput, runtimeData);
      } catch (error) {
        logToolFailure('readWorkspaceDirectory failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.readWorkspaceDirectory,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceDirectory],
  }),
  [NATIVE_TOOL_ID.writeWorkspaceFile]: ({ ports, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.writeWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<WriteWorkspaceFileInput>,
      context?: ToolExecuteContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
        input
      );
      try {
        return await runWriteWorkspaceFile(
          resolvedInput,
          runtimeData,
          ports.fileMutations,
          readToolCallId(context),
          readToolExecutionThreadId([input, context]),
          context?.abortSignal
        );
      } catch (error) {
        logToolFailure('writeWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.writeWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: ({ ports, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<StringReplaceWorkspaceFileInput>,
      context?: ToolExecuteContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
        input
      );
      try {
        return await runStringReplaceWorkspaceFile(
          resolvedInput,
          runtimeData,
          ports.fileMutations,
          readToolCallId(context),
          readToolExecutionThreadId([input, context]),
          context?.abortSignal
        );
      } catch (error) {
        logToolFailure('stringReplaceWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: ({ ports, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.deleteWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<DeleteWorkspaceFileInput>,
      context?: ToolExecuteContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
        input
      );
      try {
        return await runDeleteWorkspaceFile(
          resolvedInput,
          runtimeData,
          ports.fileMutations,
          readToolCallId(context),
          readToolExecutionThreadId([input, context]),
          context?.abortSignal
        );
      } catch (error) {
        logToolFailure('deleteWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.deleteWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
  }),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: ({ ports, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.renameWorkspaceFile],
    execute: async (
      input: ToolExecuteInput<RenameWorkspaceFileInput>,
      context?: ToolExecuteContext
    ) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
        input
      );
      try {
        return await runRenameWorkspaceFile(
          resolvedInput,
          runtimeData,
          ports.fileMutations,
          readToolCallId(context),
          readToolExecutionThreadId([input, context]),
          context?.abortSignal
        );
      } catch (error) {
        logToolFailure('renameWorkspaceFile failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.renameWorkspaceFile,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
  }),
  // `localProvider: 'unregistered'`: no fold builds it for the built-in local
  // provider (same WebGPU-prefill reasoning as the task-list tool).
  [NATIVE_TOOL_ID.manageCanvas]: ({ ports }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCanvas],
    execute: async (input: ToolExecuteInput<ManageCanvasInput>) => {
      // Envelope-validate, then narrow to the clean action branch —
      // tolerated cross-action extras are stripped here so the
      // executor/store receive exactly ManageCanvasInput.
      const resolvedInput = normalizeManageCanvasInput(
        parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCanvas], input)
      );
      try {
        return await runManageCanvas(resolvedInput, ports.canvas);
      } catch (error) {
        logToolFailure('manageCanvas failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.manageCanvas,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCanvas],
  }),
  // The two SUSPENDING native tools are registered as the factory-returned
  // Mastra Tool objects DIRECTLY (not re-wrapped in the registry's
  // { description, execute, id, inputSchema } literal shape): re-wrapping
  // would drop suspendSchema/resumeSchema and break both suspension and the
  // hasSuspendSchema fail-safe/plan-mode keep-rule. Both are
  // `localProvider: 'unregistered'`: the built-in local provider has no
  // suspend/resume, so no fold builds them for it.
  [NATIVE_TOOL_ID.askUser]: () => createAskUserTool(),
  [NATIVE_TOOL_ID.submitPlan]: () => createSubmitPlanTool(),
  // `localProvider: 'unregistered'` — the built-in local model never gets the
  // task-list tool: its persisted plan
  // is never re-injected into local instructions either (see
  // readThreadTaskListForTurn in assistant-server/agent-stream-init.ts and the provider gate on
  // buildCurrentTaskListNote in agent-runtime.ts), and the tiny on-device
  // model's WebGPU prefill budget cannot afford advertising a tool whose state
  // it will never see reflected back.
  [NATIVE_TOOL_ID.manageTaskList]: ({ ports }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageTaskList],
    execute: async (input: ToolExecuteInput<ManageTaskListInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
        input
      );
      try {
        return await runManageTaskList(resolvedInput, ports.taskList);
      } catch (error) {
        logToolFailure('manageTaskList failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.manageTaskList,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
  }),
  // Tavily /extract; the key resolves in the executing process and never
  // reaches the model, and refuseExtractUrl keeps internal URLs from leaving it.
  [NATIVE_TOOL_ID.webExtract]: ({ resolveActiveDomainCharBudget, webExtract }) =>
    webExtract
      ? {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.webExtract],
          execute: async (input: ToolExecuteInput<WebExtractInput>) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webExtract],
              input
            );
            try {
              return await runWebExtract(resolvedInput, webExtract);
            } catch (error) {
              logToolFailure('webExtract failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.webExtract,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webExtract],
          toModelOutput: (output: unknown) =>
            projectWebExtractModelOutput(output, resolveActiveDomainCharBudget()),
        }
      : undefined,
  // Tavily-backed; the key resolves in the executing process and never
  // reaches the model. A provider-native search replaces this entry only at
  // run admission, where the permission decision is known (run-admission.ts).
  [NATIVE_TOOL_ID.webSearch]: ({ resolveActiveDomainCharBudget, webSearch }) =>
    webSearch
      ? {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.webSearch],
          execute: async (input: ToolExecuteInput<WebSearchInput>) => {
            const resolvedInput = parseToolExecuteInput(
              NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webSearch],
              input
            );
            try {
              return await runWebSearch(resolvedInput, webSearch);
            } catch (error) {
              logToolFailure('webSearch failed', error, resolvedInput);
              throw error;
            }
          },
          id: NATIVE_TOOL_ID.webSearch,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webSearch],
          toModelOutput: (output: unknown) =>
            projectWebSearchModelOutput(output, resolveActiveDomainCharBudget()),
        }
      : undefined,
};
