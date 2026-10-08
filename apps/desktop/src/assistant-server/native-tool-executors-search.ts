/**
 * Executor entries for the search, retrieval, web, and browser-pane tools
 * (BST-1646 step c). Each entry builds the request-scoped Mastra registry
 * object for ONE catalog definition; `native-tool-executors.ts` assembles the
 * exhaustive map.
 */
import {
  type BrowserGetPageTextInput,
  type BrowserNavigateInput,
  type BrowserReadPageInput,
  type FindWorkspaceSymbolInput,
  type GlobWorkspaceInput,
  type GrepSearchInput,
  type HybridSearchInput,
  type ListEmbeddingSetsInput,
  type LspInspectInput,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type QueryEmbeddingSpaceInput,
  resolveGuardedToolSignal,
  type WebExtractInput,
  type WebSearchInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import type { z } from 'zod';
import { getActiveBrowserPaneHost } from '../browser/browser-pane-registry';
import {
  runBrowserGetPageText,
  runBrowserNavigate,
  runBrowserReadPage,
} from './browser-agent-tools';
import { runGlobWorkspace } from './glob-workspace-tool';
import { runGrepSearch } from './grep-search-tool';
import { runHybridSearch } from './hybrid-search-tool';
import { runListEmbeddingSpaces } from './list-embedding-spaces-tool';
import { runFindWorkspaceSymbol, runLspInspect } from './lsp-inspection-tools';
import {
  NATIVE_HYBRID_RETRIEVAL_DESCRIPTION,
  NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION,
  NativeHybridSearchInputSchema,
  NativeQueryEmbeddingSpaceInputSchema,
} from './native-retrieval-schemas';
import { executorGroup } from './native-tool-executor-context';
import { runQueryEmbeddingSpace } from './retrieval-tool';
import { withRepeatedCallGuard } from './tool-call-loop-guards';
import { attachGlobWorkspaceTelemetry, attachGrepSearchTelemetry } from './tool-call-telemetry';
import {
  logToolFailure,
  parseToolExecuteInput,
  type ToolExecuteContext,
  type ToolExecuteInput,
} from './tool-execute-support';
import { projectWebExtractModelOutput } from './web-extract-model-projection';
import { runWebExtract } from './web-extract-tool';
import { projectWebSearchModelOutput } from './web-search-model-projection';
import { runWebSearch } from './web-search-tool';
import { readStateScope } from './workspace-file-staleness';
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

export const SEARCH_TOOL_EXECUTORS = executorGroup({
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
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
    toModelOutput: (output: unknown) =>
      projectFindWorkspaceSymbolModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.lspInspect]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
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
    toModelOutput: (output: unknown) =>
      projectLspInspectModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.grepSearch]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.grepSearch],
    execute: async (input: ToolExecuteInput<GrepSearchInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
        input
      );
      try {
        return await withRepeatedCallGuard({
          input: resolvedInput,
          run: async () =>
            attachGrepSearchTelemetry(
              resolvedInput,
              await runGrepSearch(resolvedInput, runtimeData)
            ),
          threadScope: readStateScope(runtimeData),
          toolId: NATIVE_TOOL_ID.grepSearch,
        });
      } catch (error) {
        logToolFailure('grepSearch failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.grepSearch,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.grepSearch],
    toModelOutput: (output: unknown) =>
      projectGrepSearchModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.globWorkspace]: ({ resolveActiveDomainCharBudget, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.globWorkspace],
    execute: async (input: ToolExecuteInput<GlobWorkspaceInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
        input
      );
      try {
        return await withRepeatedCallGuard({
          input: resolvedInput,
          run: async () =>
            attachGlobWorkspaceTelemetry(
              resolvedInput,
              await runGlobWorkspace(resolvedInput, runtimeData)
            ),
          threadScope: readStateScope(runtimeData),
          toolId: NATIVE_TOOL_ID.globWorkspace,
        });
      } catch (error) {
        logToolFailure('globWorkspace failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.globWorkspace,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.globWorkspace],
    toModelOutput: (output: unknown) =>
      projectGlobWorkspaceModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.webSearch]: ({ dependencies, resolveActiveDomainCharBudget }) => ({
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
    toModelOutput: (output: unknown) =>
      projectWebSearchModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.webExtract]: ({ dependencies, resolveActiveDomainCharBudget }) => ({
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
    toModelOutput: (output: unknown) =>
      projectWebExtractModelOutput(output, resolveActiveDomainCharBudget()),
  }),
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: ({
    dependencies,
    resolveActiveDomainCharBudget,
    runtimeData,
  }) => {
    const inputSchema: z.ZodType<QueryEmbeddingSpaceInput> = dependencies.nativeIndexSearch
      ? NativeQueryEmbeddingSpaceInputSchema
      : NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.queryEmbeddingSpace];
    return {
      description: dependencies.nativeIndexSearch
        ? NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION
        : TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.queryEmbeddingSpace],
      execute: async (
        input: ToolExecuteInput<QueryEmbeddingSpaceInput>,
        context?: ToolExecuteContext
      ) => {
        const resolvedInput = parseToolExecuteInput(inputSchema, input);
        try {
          return await runQueryEmbeddingSpace(
            resolvedInput,
            runtimeData,
            {
              admittedWorkspaceRootIds: dependencies.admittedWorkspaceRootIds,
              embeddingHostManager: dependencies.embeddingHostManager,
              nativeIndexSearch: dependencies.nativeIndexSearch,
            },
            resolveGuardedToolSignal(context)
          );
        } catch (error) {
          logToolFailure('queryEmbeddingSpace failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.queryEmbeddingSpace,
      inputSchema,
      toModelOutput: (output: unknown) =>
        projectQueryEmbeddingSpaceModelOutput(output, resolveActiveDomainCharBudget()),
    };
  },
  [NATIVE_TOOL_ID.hybridSearch]: ({ dependencies, resolveActiveDomainCharBudget, runtimeData }) => {
    const inputSchema: z.ZodType<HybridSearchInput> = dependencies.nativeIndexSearch
      ? NativeHybridSearchInputSchema
      : NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.hybridSearch];
    return {
      description: dependencies.nativeIndexSearch
        ? NATIVE_HYBRID_RETRIEVAL_DESCRIPTION
        : TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.hybridSearch],
      execute: async (input: ToolExecuteInput<HybridSearchInput>, context?: ToolExecuteContext) => {
        const resolvedInput = parseToolExecuteInput(inputSchema, input);
        try {
          return await runHybridSearch(
            resolvedInput,
            runtimeData,
            {
              admittedWorkspaceRootIds: dependencies.admittedWorkspaceRootIds,
              embeddingHostManager: dependencies.embeddingHostManager,
              nativeIndexSearch: dependencies.nativeIndexSearch,
            },
            resolveGuardedToolSignal(context)
          );
        } catch (error) {
          logToolFailure('hybridSearch failed', error, resolvedInput);
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.hybridSearch,
      inputSchema,
      toModelOutput: (output: unknown) =>
        projectHybridSearchModelOutput(output, resolveActiveDomainCharBudget()),
    };
  },
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: ({ dependencies, runtimeData }) => ({
    description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listEmbeddingSpaces],
    execute: async (input: ToolExecuteInput<ListEmbeddingSetsInput>) => {
      const resolvedInput = parseToolExecuteInput(
        NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
        input
      );
      try {
        return await runListEmbeddingSpaces(
          resolvedInput,
          runtimeData,
          dependencies.nativeIndexSearch
        );
      } catch (error) {
        logToolFailure('listEmbeddingSpaces failed', error, resolvedInput);
        throw error;
      }
    },
    id: NATIVE_TOOL_ID.listEmbeddingSpaces,
    inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listEmbeddingSpaces],
  }),
  // Browser pane read tools (BST-1176 PR2). The active pane host is resolved
  // PER CALL from the registry — a window opened after the stream started
  // still serves, and a closed window returns the structured
  // browser_unavailable failure instead of a stale handle. Omitted for the
  // built-in local provider (same WebGPU-prefill reasoning as the task-list
  // tool and the plan-mode gate).
  [NATIVE_TOOL_ID.browserGetPageText]: ({ isLocalProvider }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserGetPageText],
          execute: (input: ToolExecuteInput<BrowserGetPageTextInput>) =>
            runBrowserGetPageText(
              parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
                input
              ),
              getActiveBrowserPaneHost()
            ),
          id: NATIVE_TOOL_ID.browserGetPageText,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserGetPageText],
        },
  [NATIVE_TOOL_ID.browserNavigate]: ({ isLocalProvider }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserNavigate],
          execute: (input: ToolExecuteInput<BrowserNavigateInput>) =>
            runBrowserNavigate(
              parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate],
                input
              ),
              getActiveBrowserPaneHost()
            ),
          id: NATIVE_TOOL_ID.browserNavigate,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserNavigate],
        },
  [NATIVE_TOOL_ID.browserReadPage]: ({ isLocalProvider }) =>
    isLocalProvider
      ? undefined
      : {
          description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.browserReadPage],
          execute: (input: ToolExecuteInput<BrowserReadPageInput>) =>
            runBrowserReadPage(
              parseToolExecuteInput(
                NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage],
                input
              ),
              getActiveBrowserPaneHost()
            ),
          id: NATIVE_TOOL_ID.browserReadPage,
          inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.browserReadPage],
        },
});
