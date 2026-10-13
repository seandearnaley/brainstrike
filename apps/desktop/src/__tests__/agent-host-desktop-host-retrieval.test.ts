// @vitest-environment node
import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import type { HostTool, HostToolContext } from '@brainstrike/agent-host';
import { SecretReadError } from '@brainstrike/agent-host/credential-contract';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import type {
  IndexerCoverageRequest,
  IndexerSearchResult,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { expect, test, vi } from 'vitest';
import { mainPlatformConnection } from '../agent-host-platform/connection';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import type { MainRequest } from '../agent-host-platform/host-retrieval-clients';
import { serveDesktopPlatform } from '../agent-host-platform/main-platform';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import { HostedEmbeddingError } from '../hosted-embeddings';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { UtilityPort } from './fixtures/admitted-host-tools';
import { mainReads as admissionReads } from './fixtures/desktop-admission-reads';

// The native index and catalog answer the way Main's IndexSearchCapability and
// PGlite catalog do; only their transport (Main's typed reads) is under test.
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
  profileHash: createHash('sha256')
    .update(
      JSON.stringify([
        profile.modelId,
        profile.revision,
        profile.dtype,
        profile.dimensions,
        profile.tokenCap,
      ])
    )
    .digest('hex'),
} as const;
const status: IndexerStatus = {
  authorizedCollectionIds: ['selected'],
  authorizedRootIds: ['root-a'],
  collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
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

function coverage(scope: IndexerCoverageRequest) {
  return {
    ...(scope.collectionId === undefined
      ? {}
      : { collections: [{ ...counts, embeddingSetId: scope.collectionId }] }),
    embedding,
    roots: scope.rootIds.map((rootId) => ({ ...counts, rootId })),
    storeId: result.storeId,
    totals: counts,
    vectorCoverageComplete: true,
  };
}

/** Main's typed reads for one host thread, as host-tool-services answers them; and the admission's roots. */
function mainReads() {
  return vi.fn(async (method: string, input: unknown): Promise<unknown> => {
    const { request, threadId } = (input ?? {}) as { request?: unknown; threadId?: string };
    // Every index and catalog read names the thread it serves.
    if (method.startsWith('desktop-read/') && threadId !== 'host-thread') {
      throw new Error(`Unscoped read ${method}`);
    }
    switch (method) {
      case 'admission/fresh-roots':
        return roots;
      case 'desktop-read/index/status':
        return status;
      case 'desktop-read/index/search':
      case 'desktop-read/index/grep':
        return result;
      case 'desktop-read/index/coverage':
        return coverage(request as IndexerCoverageRequest);
      case 'desktop-read/index/coverage-batch':
        return {
          coverage: (request as IndexerCoverageRequest[]).map(coverage),
          kind: 'current',
          status,
        };
      // Reads that can refuse answer with an outcome (BST-1996).
      case 'desktop-read/retrieval/embedding-set':
        return { ok: true, result: embeddingSetRow };
      case 'desktop-read/retrieval/file-records':
        return { ok: true, result: [fileRecord] };
      case 'desktop-read/retrieval/embedding-spaces':
        return { ok: true, result: [space] };
      case 'platform/embedding/query':
        return { ok: true, result: queryVector };
      default:
        throw new Error(`Unexpected Main request ${method}`);
    }
  });
}

function hostTools(request: MainRequest): Record<string, HostTool> {
  const descriptor = (id: string) => ({
    description: id,
    identity: id,
    inputSchema: { type: 'object' },
    permissionToolId: id,
    risk: 'read',
  });
  return desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: PlatformSelectionSchema.parse({
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

/** Only the admission's roots, Main's typed reads and the renderer query embedding are asked for. */
function expectOnlyReads(request: ReturnType<typeof mainReads>): void {
  for (const [method] of request.mock.calls) {
    expect(method).toMatch(
      /^(admission\/fresh-roots|desktop-read\/(index|retrieval)\/.+|platform\/embedding\/query)$/u
    );
  }
}

test('the desktop host runs queryEmbeddingSpace in its own process over Main’s index reads', async () => {
  const request = mainReads();
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

test('the desktop host runs hybridSearch in its own process over Main’s index reads', async () => {
  const request = mainReads();
  const output = await tool(hostTools(request), 'brainstrike_hybridSearch').execute(
    { embeddingSetId: 'selected', query: 'marker' },
    execution()
  );
  expect(output).toMatchObject({
    results: [expect.objectContaining({ filePath: 'a.txt', rootName: 'A' })],
  });
  expect(request.mock.calls.map(([method]) => method)).toContain('desktop-read/index/grep');
  expectOnlyReads(request);
});

test('hybridSearch without an explicit set searches the native index’s one authorized collection', async () => {
  // Host runs carry no renderer-sent workspace-index set: the native index status names it.
  const request = mainReads();
  const output = await tool(hostTools(request), 'brainstrike_hybridSearch').execute(
    { query: 'marker' },
    execution()
  );
  expect(output).toMatchObject({
    results: [expect.objectContaining({ filePath: 'a.txt', rootName: 'A' })],
  });
  // The default came from the index status's one authorized collection.
  expect(request.mock.calls.map(([method]) => method)).toContain('desktop-read/index/status');
  expect(request).toHaveBeenCalledWith('desktop-read/retrieval/embedding-set', {
    request: { embeddingSetId: 'selected' },
    threadId: 'host-thread',
  });
  expectOnlyReads(request);
});

test('the desktop host runs listEmbeddingSpaces in its own process over Main’s catalog read', async () => {
  const request = mainReads();
  const output = await tool(hostTools(request), 'brainstrike_listEmbeddingSpaces').execute(
    {},
    execution()
  );
  expect(output).toMatchObject({
    count: 1,
    spaces: [expect.objectContaining({ id: 'selected' })],
  });
  expect(request).toHaveBeenCalledWith('desktop-read/retrieval/embedding-spaces', {
    request: { includeStats: false },
    threadId: 'host-thread',
  });
  expectOnlyReads(request);
});

const GENERIC_FAILURE = 'The tool did not complete successfully. Try another approach.';

/** Main's workspace index, answering as the typed reads above do. */
const mainIndex: IndexSearchCapability = {
  coverage: async (scope) => coverage(scope),
  coverageBatch: async (scopes) => ({ coverage: scopes.map(coverage), kind: 'current', status }),
  grep: async () => result,
  rebuild: () => Promise.reject(new Error('A host read never rebuilds the index')),
  search: async () => result,
  status: async () => status,
};

/**
 * Main's real platform server over a real port pair, as the host's connection
 * reaches it in the app. JSON-RPC carries an error's message but never its
 * type, so only a refusal Main answers as data can reach the model typed.
 */
function servedMain(main: {
  readonly embeddingSpaces?: RetrievalStore['embeddingSpaces'];
  readonly queryEmbedding?: () => Promise<number[]>;
}) {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const hostPort = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(mainPort);
  const client = mainPlatformConnection(hostPort);
  const owner = serveDesktopPlatform(server, {
    admission: admissionReads(),
    hostTools: {
      indexSearch: mainIndex,
      retrievalStore: {
        embeddingSet: async () => embeddingSetRow,
        embeddingSpaces: main.embeddingSpaces ?? (async () => [space]),
        fileRecords: async () => new Map([[fileRecord.id, fileRecord]]),
      },
    },
    localEmbedding: { queryEmbedding: main.queryEmbedding ?? (async () => queryVector) },
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  client.listen();
  // The admission's roots are the host's own; every other read crosses to Main.
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

test('a refusal Main’s retrieval catalog raises reaches the model verbatim', async () => {
  const refused = new ToolInputError('Main refused this catalog read; retry without stats.');
  const main = servedMain({ embeddingSpaces: () => Promise.reject(refused) });
  try {
    const output = await tool(main.tools, 'brainstrike_listEmbeddingSpaces').execute(
      {},
      execution()
    );
    expect(output).toEqual(refusal(NATIVE_TOOL_ID.listEmbeddingSpaces, refused.message));
  } finally {
    await main.close();
  }
});

test('an unexpected Main retrieval catalog fault stays redacted', async () => {
  const fault = new Error(`relation "embedding_sets" is unreadable: ${LEAK}`);
  const main = servedMain({ embeddingSpaces: () => Promise.reject(fault) });
  try {
    const output = await tool(main.tools, 'brainstrike_listEmbeddingSpaces').execute(
      {},
      execution()
    );
    expect(output).toEqual({
      error: {
        code: 'tool_failed',
        message: GENERIC_FAILURE,
        toolName: NATIVE_TOOL_ID.listEmbeddingSpaces,
      },
      ok: false,
    });
  } finally {
    await main.close();
  }
});

test('Main’s real reads answer the host’s retrieval as in the app', async () => {
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
