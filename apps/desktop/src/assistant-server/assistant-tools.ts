import {
  createAskUserTool,
  createSubmitPlanTool,
  type DeleteWorkspaceFileInput,
  type ExecuteCommandInput,
  type FindWorkspaceSymbolInput,
  type GlobWorkspaceInput,
  type GrepSearchInput,
  type HybridSearchInput,
  type InspectCommandSessionsInput,
  type ListEmbeddingSetsInput,
  type ListWorkspaceContextInput,
  type LspInspectInput,
  type ManageCommandSessionInput,
  type ManageTaskListInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  projectToolOutputArtifactPage,
  type QueryEmbeddingSpaceInput,
  type QuerySelfInput,
  type ReadToolOutputArtifactCursorInput,
  type ReadWorkspaceContextInput,
  type ReadWorkspaceDirectoryInput,
  type ReadWorkspaceFileInput,
  type RenameWorkspaceFileInput,
  type RunSkillScriptInput,
  type RuntimeData,
  readToolOutputArtifactPage,
  type ScannedWorkspaceSkills,
  type ScopedToolOutputArtifactReader,
  type StringReplaceWorkspaceFileInput,
  type UpdateWorkspaceContextSelectionInput,
  type UpdateWorkspaceTapestrySelectionsInput,
  type WebExtractInput,
  type WebSearchInput,
  type WriteWorkspaceFileInput,
} from '@brainstrike/agent';
import {
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { CommandSessionManager } from './command-session-manager';
import {
  INSPECT_COMMAND_SESSIONS_TRANSFORM,
  MANAGE_COMMAND_SESSION_TRANSFORM,
  runInspectCommandSessions,
  runManageCommandSession,
} from './command-session-tools';
import { runExecuteCommand } from './execute-command-tool';
import {
  runDeleteWorkspaceFile,
  runRenameWorkspaceFile,
  runStringReplaceWorkspaceFile,
  runWriteWorkspaceFile,
} from './file-mutation-tools';
import { runGlobWorkspace } from './glob-workspace-tool';
import { runGrepSearch } from './grep-search-tool';
import { runHybridSearch } from './hybrid-search-tool';
import { runListEmbeddingSpaces } from './list-embedding-spaces-tool';
import { runFindWorkspaceSymbol, runLspInspect } from './lsp-inspection-tools';
import { runManageTaskList } from './manage-task-list-tool';
import { projectQuerySelfModelOutput } from './query-self-model-projection';
import { runQuerySelf, toQuerySelfInputError } from './query-self-tool';
import { runReadWorkspaceDirectory } from './read-workspace-directory-tool';
import {
  type ReadWorkspaceFileCursorRegistry,
  readWorkspaceFileCursorRegistry,
} from './read-workspace-file-cursor-registry';
import { runReadWorkspaceFile } from './read-workspace-file-tool';
import { runQueryEmbeddingSpace } from './retrieval-tool';
import { runSkillScript } from './run-skill-script-tool';
import {
  logToolFailure,
  parseToolExecuteInput,
  readToolCallId,
  resolveShellOutputStreamer,
  resolveToolExecuteInputCandidate,
  type ToolExecuteContext,
  type ToolExecuteInput,
  type ToolExecuteRunContext,
} from './tool-execute-support';
import { projectWebExtractModelOutput } from './web-extract-model-projection';
import { runWebExtract, type WebExtractToolDependencies } from './web-extract-tool';
import { projectWebSearchModelOutput } from './web-search-model-projection';
import { runWebSearch, type WebSearchToolDependencies } from './web-search-tool';
import { projectListWorkspaceContextModelOutput } from './workspace-context-model-projection';
import {
  runListWorkspaceContext,
  runReadWorkspaceContext,
  runUpdateWorkspaceContextSelection,
  runUpdateWorkspaceTapestrySelections,
} from './workspace-context-tools';
import {
  projectFindWorkspaceSymbolModelOutput,
  projectLspInspectModelOutput,
} from './workspace-inspection-model-projections';
import {
  projectHybridSearchModelOutput,
  projectQueryEmbeddingSpaceModelOutput,
} from './workspace-retrieval-model-projections';
import {
  projectGlobWorkspaceModelOutput,
  projectGrepSearchModelOutput,
} from './workspace-search-model-projections';

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

export interface DesktopAssistantToolDependencies {
  commandSessionManager?: CommandSessionManager | undefined;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  readWorkspaceFileCursorRegistry?: ReadWorkspaceFileCursorRegistry | undefined;
  skillScriptResolver?: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> | undefined;
  toolOutputArtifactReader?: ScopedToolOutputArtifactReader | undefined;
  /**
   * Optional override for the webSearch tool's network/key resolution. Used by
   * tests to inject a stubbed Tavily fetch and key resolver so the loop runs
   * hermetically. In production this is omitted and runWebSearch resolves the
   * real keychain key and uses the real fetch.
   */
  /** Same injection seam as `webSearch`, for the webExtract tool. */
  webExtract?: WebExtractToolDependencies | undefined;
  webSearch?: WebSearchToolDependencies | undefined;
}

const logger = createLogger('DesktopAssistantTools');

function resolveQueryEmbeddingSpaceInput(
  input: ToolExecuteInput<QueryEmbeddingSpaceInput>
): QueryEmbeddingSpaceInput {
  const raw = resolveToolExecuteInputCandidate(
    NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryEmbeddingSpace],
    input
  ) as Partial<QueryEmbeddingSpaceInput>;
  return NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryEmbeddingSpace].parse(raw);
}

/**
 * True when the request targets the built-in on-device provider. Mirrors
 * `isLocalChatProvider` in assistant-server.ts (kept separate: that module
 * pulls in Electron IPC imports this file must stay free of for its own
 * unit-test surface).
 */
function isLocalProviderRuntime(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

/**
 * Builds the Mastra ToolsInput for the desktop assistant server.
 */
export function buildDesktopAssistantTools(
  runtimeData: RuntimeData | undefined,
  dependencies: DesktopAssistantToolDependencies = {}
): MastraTools {
  // The built-in local model never gets the task-list tool: its persisted plan
  // is never re-injected into local instructions either (see
  // readThreadTaskListForTurn in assistant-server.ts and the provider gate on
  // buildCurrentTaskListNote in agent-runtime.ts), and the tiny on-device
  // model's WebGPU prefill budget cannot afford advertising a tool whose state
  // it will never see reflected back.
  const isLocalProvider = isLocalProviderRuntime(runtimeData);
  const readFileCursorRegistry =
    dependencies.readWorkspaceFileCursorRegistry ?? readWorkspaceFileCursorRegistry;
  const toolOutputArtifactReader = dependencies.toolOutputArtifactReader;
  const tools: MastraTools = {
    [NATIVE_TOOL_ID.findWorkspaceSymbol]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.findWorkspaceSymbol],
      execute: async (input: ToolExecuteInput<FindWorkspaceSymbolInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.findWorkspaceSymbol],
          input
        );
        try {
          return await runFindWorkspaceSymbol(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('findWorkspaceSymbol failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.findWorkspaceSymbol,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.findWorkspaceSymbol],
      toModelOutput: projectFindWorkspaceSymbolModelOutput,
    },
    [NATIVE_TOOL_ID.lspInspect]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.lspInspect],
      execute: async (input: ToolExecuteInput<LspInspectInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.lspInspect],
          input
        );
        try {
          return await runLspInspect(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('lspInspect failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.lspInspect,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.lspInspect],
      toModelOutput: projectLspInspectModelOutput,
    },
    [NATIVE_TOOL_ID.grepSearch]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.grepSearch],
      execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
          input
        );
        try {
          return await runGrepSearch(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('grepSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.grepSearch,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
      toModelOutput: projectGrepSearchModelOutput,
    },
    [NATIVE_TOOL_ID.globWorkspace]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.globWorkspace],
      execute: async (input: ToolExecuteInput<GlobWorkspaceInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
          input
        );
        try {
          return await runGlobWorkspace(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('globWorkspace failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.globWorkspace,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
      toModelOutput: projectGlobWorkspaceModelOutput,
    },
    [NATIVE_TOOL_ID.querySelf]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.querySelf],
      execute: async (input: ToolExecuteInput<QuerySelfInput>) => {
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
          return await runQuerySelf(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('querySelf failed', error, resolvedInput ?? {});
          throw resolvedInput === undefined ? toQuerySelfInputError(error) : error;
        }
      },
      id: NATIVE_TOOL_ID.querySelf,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.querySelf],
      toModelOutput: projectQuerySelfModelOutput,
    },
    [NATIVE_TOOL_ID.webSearch]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.webSearch],
      // The Tavily key is resolved server-side inside runWebSearch and never
      // returned to the model. No injected deps here → real fetch + keychain.
      execute: async (input: ToolExecuteInput<WebSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webSearch],
          input
        );
        try {
          return await runWebSearch(resolvedInput, dependencies.webSearch);
        } catch (error) {
          logToolFailure('webSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.webSearch,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webSearch],
      toModelOutput: projectWebSearchModelOutput,
    },
    [NATIVE_TOOL_ID.webExtract]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.webExtract],
      // The Tavily key is resolved server-side inside runWebExtract and never
      // returned to the model. No injected deps here → real fetch + keychain.
      execute: async (input: ToolExecuteInput<WebExtractInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webExtract],
          input
        );
        try {
          return await runWebExtract(resolvedInput, dependencies.webExtract);
        } catch (error) {
          logToolFailure('webExtract failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.webExtract,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.webExtract],
      toModelOutput: projectWebExtractModelOutput,
    },
    [NATIVE_TOOL_ID.readWorkspaceFile]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceFile],
      execute: async (input: ToolExecuteInput<ReadWorkspaceFileInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
          input
        );
        try {
          return await runReadWorkspaceFile(resolvedInput, runtimeData, readFileCursorRegistry);
        } catch (error) {
          logToolFailure('readWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.readWorkspaceFile,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceFile],
      toModelOutput: (output: unknown) => ({ type: 'json', value: output }),
    },
    ...(toolOutputArtifactReader
      ? {
          [NATIVE_TOOL_ID.readToolOutputArtifact]: {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readToolOutputArtifact],
            execute: async (input: ToolExecuteInput<ReadToolOutputArtifactCursorInput>) => {
              const resolvedInput = parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
                input
              );
              try {
                return await readToolOutputArtifactPage(
                  { ...resolvedInput, mode: 'cursor' },
                  {
                    reader: toolOutputArtifactReader,
                  }
                );
              } catch (error) {
                logToolFailure('readToolOutputArtifact failed', error, resolvedInput);
                throw error;
              }
            },
            id: NATIVE_TOOL_ID.readToolOutputArtifact,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readToolOutputArtifact],
            toModelOutput: projectToolOutputArtifactPage,
          },
        }
      : {}),
    [NATIVE_TOOL_ID.writeWorkspaceFile]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.writeWorkspaceFile],
      execute: async (
        input: ToolExecuteInput<WriteWorkspaceFileInput>,
        context?: ToolExecuteRunContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
          input
        );
        try {
          return await runWriteWorkspaceFile(resolvedInput, runtimeData, readToolCallId(context));
        } catch (error) {
          logToolFailure('writeWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.writeWorkspaceFile,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile],
    },
    [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
      execute: async (
        input: ToolExecuteInput<StringReplaceWorkspaceFileInput>,
        context?: ToolExecuteRunContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
          input
        );
        try {
          return await runStringReplaceWorkspaceFile(
            resolvedInput,
            runtimeData,
            readToolCallId(context)
          );
        } catch (error) {
          logToolFailure('stringReplaceWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
    },
    [NATIVE_TOOL_ID.deleteWorkspaceFile]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.deleteWorkspaceFile],
      execute: async (
        input: ToolExecuteInput<DeleteWorkspaceFileInput>,
        context?: ToolExecuteRunContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
          input
        );
        try {
          return await runDeleteWorkspaceFile(resolvedInput, runtimeData, readToolCallId(context));
        } catch (error) {
          logToolFailure('deleteWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.deleteWorkspaceFile,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
    },
    [NATIVE_TOOL_ID.renameWorkspaceFile]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.renameWorkspaceFile],
      execute: async (
        input: ToolExecuteInput<RenameWorkspaceFileInput>,
        context?: ToolExecuteRunContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
          input
        );
        try {
          return await runRenameWorkspaceFile(resolvedInput, runtimeData, readToolCallId(context));
        } catch (error) {
          logToolFailure('renameWorkspaceFile failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.renameWorkspaceFile,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.renameWorkspaceFile],
    },
    [NATIVE_TOOL_ID.readWorkspaceDirectory]: {
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
    },
    [NATIVE_TOOL_ID.listWorkspaceContext]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorkspaceContext],
      execute: async (input: ToolExecuteInput<ListWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
          input
        );
        try {
          return runListWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('listWorkspaceContext failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.listWorkspaceContext,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorkspaceContext],
      toModelOutput: projectListWorkspaceContextModelOutput,
    },
    [NATIVE_TOOL_ID.readWorkspaceContext]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.readWorkspaceContext],
      execute: async (input: ToolExecuteInput<ReadWorkspaceContextInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
          input
        );
        try {
          return await runReadWorkspaceContext(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('readWorkspaceContext failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.readWorkspaceContext,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.readWorkspaceContext],
    },
    [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
      execute: async (input: ToolExecuteInput<UpdateWorkspaceContextSelectionInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
          input
        );
        try {
          return await runUpdateWorkspaceContextSelection(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('updateWorkspaceContextSelection failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.updateWorkspaceContextSelection,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceContextSelection],
    },
    [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
      execute: async (input: ToolExecuteInput<UpdateWorkspaceTapestrySelectionsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
          input
        );
        try {
          return await runUpdateWorkspaceTapestrySelections(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('updateWorkspaceTapestrySelections failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.updateWorkspaceTapestrySelections,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.updateWorkspaceTapestrySelections],
    },
    [NATIVE_TOOL_ID.listEmbeddingSpaces]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listEmbeddingSpaces],
      execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
          input
        );
        try {
          return await runListEmbeddingSpaces(resolvedInput, runtimeData);
        } catch (error) {
          logToolFailure('listEmbeddingSpaces failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.listEmbeddingSpaces,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
    },
    ...(isLocalProvider
      ? {}
      : {
          // The two SUSPENDING native tools are registered as the factory-returned
          // Mastra Tool objects DIRECTLY (not re-wrapped in the registry's
          // { description, execute, id, inputSchema } literal shape): re-wrapping
          // would drop suspendSchema/resumeSchema and break both suspension and the
          // hasSuspendSchema fail-safe/plan-mode keep-rule. Excluded for the
          // built-in local provider (same WebGPU-prefill reasoning as the task-list
          // tool and the plan-mode gate).
          [NATIVE_TOOL_ID.askUser]: createAskUserTool(),
          [NATIVE_TOOL_ID.submitPlan]: createSubmitPlanTool(),
          [NATIVE_TOOL_ID.manageTaskList]: {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageTaskList],
            execute: async (input: ToolExecuteInput<ManageTaskListInput>) => {
              const resolvedInput = parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
                input
              );
              try {
                return await runManageTaskList(resolvedInput, runtimeData);
              } catch (error) {
                logToolFailure('manageTaskList failed', error, resolvedInput);
                throw error;
              }
            },
            id: NATIVE_TOOL_ID.manageTaskList,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageTaskList],
          },
        }),
    [NATIVE_TOOL_ID.queryEmbeddingSpace]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryEmbeddingSpace],
      execute: async (input: ToolExecuteInput<QueryEmbeddingSpaceInput>) => {
        const resolvedInput = resolveQueryEmbeddingSpaceInput(input);
        try {
          return await runQueryEmbeddingSpace(resolvedInput, runtimeData, {
            embeddingHostManager: dependencies.embeddingHostManager,
          });
        } catch (error) {
          logToolFailure('queryEmbeddingSpace failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.queryEmbeddingSpace,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryEmbeddingSpace],
      toModelOutput: projectQueryEmbeddingSpaceModelOutput,
    },
    [NATIVE_TOOL_ID.hybridSearch]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.hybridSearch],
      execute: async (input: ToolExecuteInput<HybridSearchInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.hybridSearch],
          input
        );
        try {
          return await runHybridSearch(resolvedInput, runtimeData, {
            embeddingHostManager: dependencies.embeddingHostManager,
          });
        } catch (error) {
          logToolFailure('hybridSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.hybridSearch,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.hybridSearch],
      toModelOutput: projectHybridSearchModelOutput,
    },
    ...(isLocalProvider
      ? {}
      : {
          [NATIVE_TOOL_ID.inspectCommandSessions]: {
            description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.inspectCommandSessions],
            execute: (input: ToolExecuteInput<InspectCommandSessionsInput>) => {
              const resolvedInput = parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
                input
              );
              try {
                return runInspectCommandSessions(resolvedInput, runtimeData, {
                  ...(dependencies.commandSessionManager
                    ? { manager: dependencies.commandSessionManager }
                    : {}),
                });
              } catch (error) {
                logToolFailure('inspectCommandSessions failed', error, resolvedInput);
                throw error;
              }
            },
            id: NATIVE_TOOL_ID.inspectCommandSessions,
            inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.inspectCommandSessions],
            transform: INSPECT_COMMAND_SESSIONS_TRANSFORM,
          },
        }),
  };

  if (!isLocalProvider) {
    tools[NATIVE_TOOL_ID.manageCommandSession] = {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageCommandSession],
      execute: async (
        input: ToolExecuteInput<ManageCommandSessionInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
          input
        );
        try {
          return await runManageCommandSession(resolvedInput, runtimeData, {
            ...(dependencies.commandSessionManager
              ? { manager: dependencies.commandSessionManager }
              : {}),
            ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
          });
        } catch (error) {
          logToolFailure('manageCommandSession failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.manageCommandSession,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageCommandSession],
      transform: MANAGE_COMMAND_SESSION_TRANSFORM,
    };
  }

  // Arbitrary shell execution is registered like every other native tool and
  // gated by the permission engine. With enforce-on-by-default, its 'execute'
  // risk bucket resolves to 'ask', so the run SUSPENDS for per-call approval
  // before the command runs (approve → execute, decline → skip). A user can set
  // execute to 'allow'/yolo to run it unprompted, or 'deny' to omit it — that is
  // the permission gate's job now, not a registration-time conditional.
  tools[NATIVE_TOOL_ID.executeCommand] = {
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.executeCommand],
    // The second arg carries the Mastra ToolExecutionContext, whose abortSignal
    // we thread into the run so a cancelled run kills the process tree, and whose
    // stream writer + tool-call id we use to stream incremental stdout/stderr to
    // the live tool card. Mastra hands a DIFFERENT context shape to a plain tool
    // object (raw `outputWriter` fn + top-level `toolCallId`) vs a `createTool`
    // instance (`writer.custom` + `agent.toolCallId`); we accept both.
    // `resolveShellOutputStreamer` returns undefined when neither is present, so
    // the command still runs and returns its full captured result — only the
    // live slices are skipped (capability presence, not a policy fallback).
    execute: async (input: ToolExecuteInput<ExecuteCommandInput>, options?: ToolExecuteContext) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
        input
      );
      const stream = resolveShellOutputStreamer(options, (error) => {
        logToolFailure('executeCommand output streaming failed', error, resolvedInput);
      });
      try {
        return await runExecuteCommand(resolvedInput, runtimeData, {
          signal: options?.abortSignal,
          ...(stream ? { stream } : {}),
        });
      } catch (error) {
        logToolFailure('executeCommand failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.executeCommand,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.executeCommand],
  };

  const skillScriptResolver = dependencies.skillScriptResolver;
  if (skillScriptResolver) {
    tools[NATIVE_TOOL_ID.runSkillScript] = {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.runSkillScript],
      execute: async (
        input: ToolExecuteInput<RunSkillScriptInput>,
        options?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
          input
        );
        const stream = resolveShellOutputStreamer(options, (error) => {
          logToolFailure('runSkillScript output streaming failed', error, resolvedInput);
        });
        try {
          return await runSkillScript(resolvedInput, runtimeData, skillScriptResolver, {
            signal: options?.abortSignal,
            ...(stream ? { stream } : {}),
          });
        } catch (error) {
          logToolFailure('runSkillScript failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.runSkillScript,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.runSkillScript],
    };
  }

  const enabledNativeToolIds = runtimeData?.enabledNativeToolIds;
  if (!Array.isArray(enabledNativeToolIds)) {
    return tools;
  }

  const enabledSet = new Set(
    enabledNativeToolIds.filter((toolId): toolId is string => typeof toolId === 'string')
  );
  const unknownToolIds = Array.from(enabledSet).filter((toolId) => !isDesktopNativeToolId(toolId));
  if (unknownToolIds.length > 0) {
    throw new Error('Enabled native tool preferences contain unknown tool IDs.');
  }
  const unavailableToolIds = Array.from(enabledSet).filter(
    (toolId) =>
      tools[toolId] === undefined &&
      // Skill execution is capability-gated by the trusted per-request scan
      // engine. A persisted preference may still name it while Skills are
      // disabled; omission is the explicit capability result, not corruption.
      toolId !== NATIVE_TOOL_ID.runSkillScript
  );
  if (unavailableToolIds.length > 0) {
    logger.debug('Enabled native tool ids unavailable in the current runtime', {
      toolIds: unavailableToolIds,
    });
  }
  if (enabledSet.size === 0) {
    logger.warn('Runtime preferences disabled all desktop assistant native tools', {
      availableCount: Object.keys(tools).length,
    });
  }
  const filteredTools: MastraTools = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    if (enabledSet.has(toolId)) {
      filteredTools[toolId] = tool;
    }
  }
  const disabledCount = Object.keys(tools).length - Object.keys(filteredTools).length;
  if (disabledCount > 0) {
    logger.debug('Filtered desktop assistant native tools', {
      disabledCount,
      enabledCount: Object.keys(filteredTools).length,
    });
  }
  return filteredTools;
}
