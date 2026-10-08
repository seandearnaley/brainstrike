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
  NATIVE_TOOL_INPUT_SCHEMAS,
  type WebExtractInput,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import {
  logToolFailure,
  type NativeToolExecutor,
  parseToolExecuteInput,
  type ToolExecuteInput,
} from '@brainstrike/host-capabilities/native-tools';
import { getActiveBrowserPaneHost } from '../browser/browser-pane-registry';
import {
  runBrowserGetPageText,
  runBrowserNavigate,
  runBrowserReadPage,
} from './browser-agent-tools';
import { pgliteGrepIndex } from './grep-search-tool';
import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { grepSearchExecutor } from './native-tool-executors-grep';
import { retrievalToolExecutors } from './native-tool-executors-retrieval';
import { pgliteRetrievalStore } from './retrieval-store-pglite';
import { projectWebExtractModelOutput } from './web-extract-model-projection';
import { runWebExtract } from './web-extract-tool';

/** Main's retrieval reads its own PGlite catalog beside its native index capability. */
function mainRetrieval(
  id: keyof ReturnType<typeof retrievalToolExecutors>
): (context: DesktopToolBuildContext) => ReturnType<NativeToolExecutor> {
  return (context) =>
    retrievalToolExecutors(() => ({
      dependencies: {
        admittedWorkspaceRootIds: context.dependencies.admittedWorkspaceRootIds,
        embeddingHostManager: context.dependencies.embeddingHostManager,
        nativeIndexSearch: context.dependencies.nativeIndexSearch,
      },
      store: pgliteRetrievalStore(),
    }))[id](context);
}

export const SEARCH_TOOL_EXECUTORS = executorGroup({
  // Main's grep reads its own PGlite file-chunk index.
  [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(pgliteGrepIndex),
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
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: mainRetrieval(NATIVE_TOOL_ID.queryEmbeddingSpace),
  [NATIVE_TOOL_ID.hybridSearch]: mainRetrieval(NATIVE_TOOL_ID.hybridSearch),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: mainRetrieval(NATIVE_TOOL_ID.listEmbeddingSpaces),
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
