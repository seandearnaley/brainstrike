// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import type { HostTool, HostToolContext } from '@brainstrike/agent-host';
import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { embeddingProfileHash } from '@brainstrike/indexer';
import {
  type IndexerCoverageBatch,
  type IndexerCoverageRequest,
  type IndexerGrepRequest,
  type IndexerSearchRequest,
  type IndexerSearchResult,
  type IndexerStatus,
  NO_WORKSPACE_FOLDER_MESSAGE,
} from '@brainstrike/indexing-contract/indexer-client';
import { Schema } from 'effect';
import { expect, test, vi } from 'vitest';
import { mainPlatformConnection } from '../agent-host-platform/connection';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import type { HostRetrieval } from '../agent-host-platform/host-executed-tools';
import type { MainRequest } from '../agent-host-platform/host-retrieval-clients';
import { serveDesktopPlatform } from '../agent-host-platform/main-platform';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';
import { HostedEmbeddingError } from '../hosted-embedding-error';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { UtilityPort } from './fixtures/admitted-host-tools';
import { mainReads as admissionReads } from './fixtures/desktop-admission-reads';

// The native index and catalog answer the way the host's IndexSearchCapability and
// catalog store do (ADR-0029 stage 4: both are the host's own, read in its process);
// only the query embedding still crosses to Main.
const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 256,
} as const;
const queryPlan = {
  inferencePlan: {
    device: 'wasm',
    dimensions: profile.dimensions,
    dtype: profile.dtype,
    modelId: profile.modelId,
    revision: profile.revision,
  },
  modelKey: `local::${profile.modelId}`,
} as const;
const embedding = {
  indexMode: 'vector-configured',
  profile,
  // The indexer's own identity rule, never a copy of its formula.
  profileHash: embeddingProfileHash(profile),
} as const;
/** The native index once its folders are scanned: the status a current coverage read carries. */
type ReadyIndexerStatus = Extract<IndexerStatus, { readonly kind: 'ready' }>;
const status: ReadyIndexerStatus = {
  authorizedCollectionIds: ['selected'],
  authorizedRootIds: ['root-a'],
  embedding,
  kind: 'ready',
  queryPlan,
  rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
  storeId: 'a'.repeat(64),
};
const result: IndexerSearchResult = {
  candidateCount: 1,
  candidatesTruncated: false,
  embedding,
  hits: [
    {
      chunkId: 'chunk-a',
      chunkIndex: 0,
      chunkSize: 384,
      chunkType: 'text',
      content: 'Selected A marker',
      contentHash: 'c'.repeat(64),
      embeddingSetId: 'selected',
      endLine: 1,
      endOffset: 17,
      fileId: 'file-a',
      relativePath: 'a.txt',
      rootId: 'root-a',
      score: 0.9,
      startLine: 1,
      startOffset: 0,
      tokenCount: 3,
    },
  ],
  scanLimited: false,
  storeId: 'a'.repeat(64),
  truncated: false,
};
const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
const embeddingSetRow = {
  dimensions: profile.dimensions,
  distance: 'cosine',
  modelId: profile.modelId,
  modelKey: queryPlan.modelKey,
};
const fileRecord = {
  id: 'file-a',
  name: 'a.txt',
  path: 'a.txt',
  rootId: 'root-a',
  rootName: 'A',
  tokenCount: 3,
};
const space = {
  createdAt: '2026-10-08T00:00:00.000Z',
  description: null,
  dimensions: profile.dimensions,
  distance: 'cosine',
  id: 'selected',
  modelId: profile.modelId,
  modelKey: queryPlan.modelKey,
  name: 'Workspace',
} as const;
const queryVector = Array.from({ length: profile.dimensions }, () => 0.1);
const roots = [{ displayName: 'A', path: '/workspace/a', rootId: 'root-a' }];
/** A folder open in the app but not in this thread, indexed like A. */
const otherFolderHit = {
  ...result.hits[0],
  chunkId: 'chunk-c',
  content: 'Other folder C marker',
  fileId: 'file-c',
  relativePath: 'c.txt',
  rootId: 'root-c',
} as IndexerSearchResult['hits'][number];
const otherFileRecord = {
  ...fileRecord,
  id: 'file-c',
  name: 'c.txt',
  path: 'c.txt',
  rootId: 'root-c',
  rootName: 'C',
};
/** The host's index over A and C; a search answers the folders it names. */
const twoFolderIndex = {
  hits: [...result.hits, otherFolderHit],
  status: {
    ...status,
    authorizedRootIds: ['root-a', 'root-c'],
    rootReadiness: [
      { rootId: 'root-a', scanComplete: true },
      { rootId: 'root-c', scanComplete: true },
    ],
  } as ReadyIndexerStatus,
};
function coverage(scope: IndexerCoverageRequest) {
  const folders = scope.rootIds.length;
  return {
    embedding,
    roots: scope.rootIds.map((rootId) => ({ ...counts, rootId })),
    storeId: result.storeId,
    // The index sums its folders' counts.
    totals: { chunks: folders, indexedFiles: folders, missingVectors: 0, vectors: folders },
    vectorCoverageComplete: true,
  };
}
/** The host's own index and retrieval catalog, answering as the native index does. */
function hostRetrieval(
  index: { readonly hits: IndexerSearchResult['hits']; readonly status: ReadyIndexerStatus } = {
    hits: result.hits,
    status,
  },
  catalog: Partial<HostRetrieval['store']> = {}
) {
  const scoped = (request: { readonly rootIds: readonly string[] }): IndexerSearchResult => ({
    ...result,
    hits: index.hits.filter((hit) => request.rootIds.includes(hit.rootId ?? '')),
  });
  return {
    indexSearch: {
      coverage: vi.fn(async (scope: IndexerCoverageRequest) => coverage(scope)),
      coverageBatch: vi.fn(
        async (requests: readonly IndexerCoverageRequest[]): Promise<IndexerCoverageBatch> => {
          // The index refuses a read naming no folder, as a typed refusal.
          if (requests.some((scope) => scope.rootIds.length === 0)) {
            throw refusalError('input', 'native-search.no-folders', NO_WORKSPACE_FOLDER_MESSAGE);
          }
          return { coverage: requests.map(coverage), kind: 'current', status: index.status };
        }
      ),
      grep: vi.fn(async (request: IndexerGrepRequest) => scoped(request)),
      rebuild: vi.fn(() => Promise.reject(new Error('A host read never rebuilds the index'))),
      search: vi.fn(async (request: IndexerSearchRequest) => scoped(request)),
      status: vi.fn(async () => index.status),
    },
    store: {
      embeddingSet: vi.fn(catalog.embeddingSet ?? (async () => embeddingSetRow)),
      embeddingSpaces: vi.fn(catalog.embeddingSpaces ?? (async () => [space])),
      fileRecords: vi.fn(
        catalog.fileRecords ??
          (async (ids: readonly string[]) =>
            new Map(
              [fileRecord, otherFileRecord]
                .filter((row) => ids.includes(row.id))
                .map((row) => [row.id, row] as const)
            ))
      ),
    },
  } satisfies HostRetrieval;
}
/** The host's Main connection: the admission's roots and the renderer query embedding. */
function mainRequests(threadRoots: readonly (typeof roots)[number][] = roots) {
  return vi.fn(async (method: string, _input: unknown): Promise<unknown> => {
    switch (method) {
      case 'admission/fresh-roots':
        return threadRoots;
      // A read that can refuse answers with an outcome (BST-1996).
      case 'platform/embedding/query':
        return { ok: true, result: queryVector };
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
}
function hostTools(
  request: MainRequest,
  retrieval: HostRetrieval = hostRetrieval()
): Record<string, HostTool> {
  const descriptor = (id: string) => ({
    description: id,
    identity: id,
    inputSchema: { type: 'object' },
    permissionToolId: id,
    risk: 'read',
  });
  return desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    gitWorkspace: {},
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    retrieval,
    selected: Schema.decodeUnknownSync(PlatformSelectionSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      configuration: { model: 'gpt-6-sol', provider: 'openai' },
      contextWindow: 32_000,
      durableConfiguration: {},
      inputTokenLimit: 24_000,
      maxSteps: 3,
      memory: {
        options: {
          lastMessages: 1,
          workingMemory: { enabled: false, scope: 'thread', template: '' },
        },
        settings: {
          observationalMemory: {
            enabled: false,
            messageTokens: 1000,
            modelTarget: 'auto',
            observationTokens: 1000,
            retrievalMode: 'off',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: null,
            enabled: false,
            messageRange: 0,
            scope: 'thread',
            topK: 1,
          },
        },
      },
      nativeRuntime: {
        provider: 'openai',
        workspaceRoots: [{ displayName: 'A', path: '/workspace/a', rootId: 'root-a' }],
      },
      resourceId: 'workspace',
      tools: {
        brainstrike_hybridSearch: descriptor(NATIVE_TOOL_ID.hybridSearch),
        brainstrike_listEmbeddingSpaces: descriptor(NATIVE_TOOL_ID.listEmbeddingSpaces),
        brainstrike_queryEmbeddingSpace: descriptor(NATIVE_TOOL_ID.queryEmbeddingSpace),
      },
      toolTimeoutMs: 5000,
    }),
    threadId: 'host-thread',
  });
}
function execution(): HostToolContext {
  return {
    edits: { track: async () => Promise.reject(new Error('A host read never edits')) },
    runId: 'host-run',
    signal: new AbortController().signal,
    state: { entries: () => [], read: async () => undefined, update: async () => undefined },
    threadId: 'host-thread',
    toolCallId: 'retrieval-call',
  };
}
function tool(tools: Record<string, HostTool>, name: string): HostTool {
  const found = tools[name];
  if (!found) {
    throw new Error(`${name} was not built for the host`);
  }
  return found;
}
/** Only the admission's roots and the renderer query embedding cross to Main. */
function expectOnlyReads(request: ReturnType<typeof mainRequests>): void {
  for (const [method] of request.mock.calls) {
    expect(method).toMatch(/^(admission\/fresh-roots|platform\/embedding\/query)$/u);
  }
}
test('the desktop host runs queryEmbeddingSpace in its own process over its own index', async () => {
  const request = mainRequests();
  const output = await tool(hostTools(request), 'brainstrike_queryEmbeddingSpace').execute(
    { embeddingSetId: 'selected', query: 'marker' },
    execution()
  );
  expect(JSON.stringify(output)).toContain('Selected A marker');
  expect(request).toHaveBeenCalledWith(
    'platform/embedding/query',
    { request: expect.objectContaining({ modelKey: queryPlan.modelKey, query: 'marker' }) },
    expect.any(AbortSignal)
  );
  expectOnlyReads(request);
});
test('the desktop host runs hybridSearch in its own process over its own index', async () => {
  const request = mainRequests();
  const retrieval = hostRetrieval();
  const output = await tool(hostTools(request, retrieval), 'brainstrike_hybridSearch').execute(
    { embeddingSetId: 'selected', query: 'marker' },
    execution()
  );
  expect(output).toMatchObject({
    results: [expect.objectContaining({ filePath: 'a.txt', rootName: 'A' })],
  });
  expect(retrieval.indexSearch.grep).toHaveBeenCalled();
  expectOnlyReads(request);
});
test('hybridSearch without an explicit set searches the native index’s one authorized collection', async () => {
  // Host runs carry no renderer-sent workspace-index set: the native index status names it.
  const request = mainRequests();
  const retrieval = hostRetrieval();
  const output = await tool(hostTools(request, retrieval), 'brainstrike_hybridSearch').execute(
    { query: 'marker' },
    execution()
  );
  expect(output).toMatchObject({
    results: [expect.objectContaining({ filePath: 'a.txt', rootName: 'A' })],
  });
  // The default came from the index status's one authorized collection.
  expect(retrieval.indexSearch.status).toHaveBeenCalled();
  expect(retrieval.store.embeddingSet).toHaveBeenCalledWith('selected');
  expectOnlyReads(request);
});
const folderB = { displayName: 'B', path: '/workspace/b', rootId: 'root-b' };
test.each(['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch'])(
  '%s without a folder searches this thread’s indexed folders and names one left out',
  async (name) => {
    // A is indexed; B (say, a worktree not opted in) is not; C is open in the app, not this thread.
    const tools = hostTools(mainRequests([...roots, folderB]), hostRetrieval(twoFolderIndex));
    const output = await tool(tools, name).execute({ query: 'marker' }, execution());
    expect(JSON.stringify(output)).toContain('Selected A marker');
    expect(JSON.stringify(output)).not.toContain('Other folder C marker');
    expect(output).toMatchObject({
      hint: expect.stringContaining('"B" is not in the search index'),
    });
  }
);
test.each(['brainstrike_queryEmbeddingSpace', 'brainstrike_hybridSearch'])(
  '%s with no folder open in the thread says to add one',
  async (name) => {
    const tools = hostTools(mainRequests([]), hostRetrieval(twoFolderIndex));
    const output = await tool(tools, name).execute({ query: 'marker' }, execution());
    expect(output).toEqual(
      refusal(
        name === 'brainstrike_hybridSearch'
          ? NATIVE_TOOL_ID.hybridSearch
          : NATIVE_TOOL_ID.queryEmbeddingSpace,
        NO_WORKSPACE_FOLDER_MESSAGE
      )
    );
  }
);
test('the desktop host runs listEmbeddingSpaces in its own process over its own catalog', async () => {
  // The space's stats are its indexed folders' files: A, scanned, and C, still scanning.
  const request = mainRequests();
  const retrieval = hostRetrieval({
    ...twoFolderIndex,
    status: {
      ...twoFolderIndex.status,
      rootReadiness: [
        { rootId: 'root-a', scanComplete: true },
        { rootId: 'root-c', scanComplete: false },
      ],
    } as ReadyIndexerStatus,
  });
  const output = await tool(
    hostTools(request, retrieval),
    'brainstrike_listEmbeddingSpaces'
  ).execute({ includeStats: true }, execution());
  expect(output).toMatchObject({
    count: 1,
    spaces: [
      expect.objectContaining({
        coverage: {
          coveragePercent: 100,
          embeddedChunks: 2,
          fileCount: 2,
          missingVectors: 0,
          scanComplete: false,
          source: 'native',
          totalChunks: 2,
          vectorCoverageComplete: true,
        },
        id: 'selected',
      }),
    ],
  });
  expect(retrieval.store.embeddingSpaces).toHaveBeenCalledWith({ includeStats: true });
  expectOnlyReads(request);
});
test('listEmbeddingSpaces stats with no folder in the index say to add one', async () => {
  const retrieval = hostRetrieval({
    hits: [],
    status: { ...status, authorizedRootIds: [], rootReadiness: [] } as ReadyIndexerStatus,
  });
  const output = await tool(
    hostTools(mainRequests(), retrieval),
    'brainstrike_listEmbeddingSpaces'
  ).execute({ includeStats: true }, execution());
  expect(output).toEqual(refusal(NATIVE_TOOL_ID.listEmbeddingSpaces, NO_WORKSPACE_FOLDER_MESSAGE));
});
const GENERIC_FAILURE = 'The tool did not complete successfully. Try another approach.';
/** Main's embedding host: only its query embedding serves the retrieval tools. */
function mainEmbedding(queryEmbedding: () => Promise<number[]>) {
  const unused = () => Promise.reject(new Error('The retrieval tools only query embeddings'));
  return { destroyAndRestart: unused, documentEmbeddings: unused, queryEmbedding, stop: unused };
}
/**
 * Main's real platform server over a real port pair, as the host's connection
 * reaches it in the app. The index and catalog are the host's own; the query
 * embedding crosses to Main. JSON-RPC carries an error's message but never its
 * type, so only a refusal Main answers as data can reach the model typed.
 */
function servedMain(main: { readonly queryEmbedding?: () => Promise<number[]> }) {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const hostPort = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(mainPort);
  const client = mainPlatformConnection(hostPort);
  const owner = serveDesktopPlatform(server, {
    admission: admissionReads(),
    localEmbedding: mainEmbedding(main.queryEmbedding ?? (async () => queryVector)),
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  client.listen();
  // The admission's roots are the host's own; the query embedding crosses to Main.
  const request: MainRequest = async (method, input) =>
    method === 'admission/fresh-roots' ? roots : await client.sendRequest(method, input);
  return {
    close: async (): Promise<void> => {
      await owner.close();
      client.dispose();
      server.dispose();
      mainPort.close();
      hostPort.close();
    },
    tools: hostTools(request),
  };
}
function refusal(toolName: string, message: string) {
  return { error: { code: 'tool_input_invalid', message, toolName }, ok: false };
}
const LEAK = 'sk-live-BST1996LEAK at /Users/someone/Library/profile';
test.each([
  ['an unreadable stored key', new SecretReadError('decrypt_failed', 'openai')],
  [
    'a missing hosted key',
    new HostedEmbeddingError('missing-key', 'No API key configured for the embedding provider.'),
  ],
  [
    'an over-long query',
    new HostedEmbeddingError('input-too-long', 'The query is too long for the embedding model.', {
      cause: LEAK,
    }),
  ],
  [
    'a provider rate limit',
    new HostedEmbeddingError(
      'rate-limit',
      'The embedding provider is rate limiting. Retry later.',
      {
        cause: LEAK,
      }
    ),
  ],
])(
  'Main’s refusal of the query embedding (%s) reaches the model verbatim',
  async (_name, error) => {
    const main = servedMain({ queryEmbedding: () => Promise.reject(error) });
    try {
      const output = await tool(main.tools, 'brainstrike_queryEmbeddingSpace').execute(
        { embeddingSetId: 'selected', query: 'marker' },
        execution()
      );
      expect(output).toEqual(refusal(NATIVE_TOOL_ID.queryEmbeddingSpace, error.message));
      expect(JSON.stringify(output)).not.toContain('BST1996LEAK');
    } finally {
      await main.close();
    }
  }
);
test.each([
  [
    'a provider status',
    new HostedEmbeddingError('provider-status', 'The embedding provider returned an error.', {
      cause: LEAK,
    }),
  ],
  [
    'a network failure',
    new HostedEmbeddingError('network', 'The embedding provider could not be reached.', {
      cause: LEAK,
    }),
  ],
  ['an unexpected fault', new Error(`ECONNRESET reading ${LEAK}`)],
])('Main’s query embedding fault (%s) stays redacted', async (_name, error) => {
  const main = servedMain({ queryEmbedding: () => Promise.reject(error) });
  try {
    const output = await tool(main.tools, 'brainstrike_queryEmbeddingSpace').execute(
      { embeddingSetId: 'selected', query: 'marker' },
      execution()
    );
    expect(output).toEqual({
      error: {
        code: 'tool_failed',
        message: GENERIC_FAILURE,
        toolName: NATIVE_TOOL_ID.queryEmbeddingSpace,
      },
      ok: false,
    });
    expect(JSON.stringify(output)).not.toContain(error.message);
  } finally {
    await main.close();
  }
});
test('a refusal the retrieval catalog raises reaches the model verbatim', async () => {
  const refused = new ToolInputError('The catalog refused this read; retry without stats.');
  const retrieval = hostRetrieval(undefined, { embeddingSpaces: () => Promise.reject(refused) });
  const output = await tool(
    hostTools(mainRequests(), retrieval),
    'brainstrike_listEmbeddingSpaces'
  ).execute({}, execution());
  expect(output).toEqual(refusal(NATIVE_TOOL_ID.listEmbeddingSpaces, refused.message));
});
test('an unexpected retrieval catalog fault stays redacted', async () => {
  const fault = new Error(`relation "embedding_sets" is unreadable: ${LEAK}`);
  const retrieval = hostRetrieval(undefined, { embeddingSpaces: () => Promise.reject(fault) });
  const output = await tool(
    hostTools(mainRequests(), retrieval),
    'brainstrike_listEmbeddingSpaces'
  ).execute({}, execution());
  expect(output).toEqual({
    error: {
      code: 'tool_failed',
      message: GENERIC_FAILURE,
      toolName: NATIVE_TOOL_ID.listEmbeddingSpaces,
    },
    ok: false,
  });
  expect(JSON.stringify(output)).not.toContain('BST1996LEAK');
});
test('Main’s real query embedding answers the host’s retrieval as in the app', async () => {
  const main = servedMain({});
  try {
    const output = await tool(main.tools, 'brainstrike_queryEmbeddingSpace').execute(
      { embeddingSetId: 'selected', query: 'marker' },
      execution()
    );
    expect(JSON.stringify(output)).toContain('Selected A marker');
  } finally {
    await main.close();
  }
});
