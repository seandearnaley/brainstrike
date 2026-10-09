import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { NativeToolExecutor } from '@brainstrike/host-capabilities/native-tools';
import { mainBrowserToolRunner } from './browser-agent-tools';
import { pgliteGrepIndex } from './grep-search-tool';
import { type DesktopToolBuildContext, executorGroup } from './native-tool-executor-context';
import { browserToolExecutors } from './native-tool-executors-browser';
import { grepSearchExecutor } from './native-tool-executors-grep';
import { retrievalToolExecutors } from './native-tool-executors-retrieval';
import { pgliteRetrievalStore } from './retrieval-store-pglite';

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
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: mainRetrieval(NATIVE_TOOL_ID.queryEmbeddingSpace),
  [NATIVE_TOOL_ID.hybridSearch]: mainRetrieval(NATIVE_TOOL_ID.hybridSearch),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: mainRetrieval(NATIVE_TOOL_ID.listEmbeddingSpaces),
  ...browserToolExecutors(mainBrowserToolRunner),
});
