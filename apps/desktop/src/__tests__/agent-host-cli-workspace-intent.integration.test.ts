// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type {
  IndexerSearchResult,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

// Observe existing owner boundaries. The actual Main adapter, context readers,
// semantic/hybrid dispatch and native scope validation remain production code.
// These causal controls do not qualify a new profile/catalog or native writer.
const owner = vi.hoisted(() => ({
  credential: vi.fn(() => {
    throw new Error('Unexpected credential access in workspace boundary control');
  }),
  fetch: vi.fn(async () => {
    throw new Error('Unexpected HTTP in workspace boundary control');
  }),
  files: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../db-main', () => ({ getDatabase: async () => ({ query: owner.query }) }));
vi.mock('../provider-api-key', () => ({
  readProviderCredential: owner.credential,
}));
vi.mock('../ipc-mcp', () => ({
  readDesktopMcpHostSnapshot: async (runtime: { host: { snapshot(): unknown } }) =>
    structuredClone(runtime.host.snapshot()),
}));
vi.mock('@brainstrike/db', async (original) => ({
  ...(await original<typeof import('@brainstrike/db')>()),
  FileRecordRepository: class {
    findByIds = owner.files;
  },
}));

import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-wire';
import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';

const directories: string[] = [];
let roots: { id: string; displayName: string; path: string }[] = [];
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', owner.fetch);
  owner.files.mockResolvedValue([
    { id: 'file-b', name: 'b.txt', path: 'b.txt', rootId: 'root-b', tokenCount: 3 },
  ]);
  owner.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM models')) {
      return { rows: [{ isEnabled: true, providerId: 'openai' }] };
    }
    if (sql.includes('FROM roots') && !sql.includes('file_records')) {
      return { rows: roots.map((root) => ({ ...root })) };
    }
    if (sql.includes('FROM embedding_sets')) {
      return {
        rows: [
          {
            dimensions: 384,
            distance: 'cosine',
            modelId: profile.modelId,
            modelKey: queryPlan.modelKey,
          },
        ],
      };
    }
    if (sql.includes('file_records')) {
      return { rows: [{ id: 'file-b', rootId: 'root-b', rootName: 'B' }] };
    }
    throw new Error('Unexpected owner query in workspace boundary control');
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  roots = [];
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { force: true, recursive: true });
  }
  expect(owner.credential).not.toHaveBeenCalled();
  expect(owner.fetch).not.toHaveBeenCalled();
});

async function workspace() {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'bs-m3-adapter-roots-')));
  directories.push(directory);
  roots = [
    { displayName: 'A', id: 'root-a', path: join(directory, 'a') },
    { displayName: 'B', id: 'root-b', path: join(directory, 'b') },
  ];
  for (const root of roots) {
    await fs.mkdir(root.path);
    await fs.writeFile(join(root.path, 'AGENTS.md'), `Instructions for ${root.displayName}.`);
    await fs.writeFile(join(root.path, 'note.txt'), `Reference for ${root.displayName}.`);
  }
  return { a: roots[0]!.path, b: roots[1]!.path };
}
function intent() {
  return PlatformClientConfigurationSchema.parse({
    agentLoop: { inputTokenLimit: 7000, maxSteps: 3 },
    enabledNativeToolIds: [],
    memoryOptions: {
      lastMessages: 1,
      workingMemory: { enabled: false, scope: 'thread', template: 'Owner template' },
    },
    memorySettings: {
      observationalMemory: {
        enabled: false,
        messageTokens: 1234,
        modelTarget: 'auto',
        observationTokens: 2345,
        retrievalMode: 'messages',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 0,
        scope: 'thread',
        topK: 2,
      },
    },
    modelConfiguration: {
      model: 'gpt-6-sol',
      modelSettings: { maxOutputTokens: 97, temperature: 0.31 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    },
    permissionPolicy: {
      perToolOverrides: { 'brainstrike.writeWorkspaceFile': 'deny' },
      policies: DEFAULT_PERMISSION_POLICIES,
      yolo: false,
    },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    workspaceContext: {
      files: [
        {
          approxTokens: null,
          outputApproxTokens: null,
          path: 'note.txt',
          ranges: [],
          rootId: 'root-a',
        },
      ],
      includeProjectTree: false,
      projectTreeApproxTokens: null,
      projectTreeTokenCountLoading: false,
      selectedOutputApproxTokens: null,
      selectedSourceApproxTokens: null,
      tokenBudget: 321,
    },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
}
function request(configuration: unknown): HostRunAdmissionRequest {
  return {
    configuration: z.record(z.string(), z.json()).parse(configuration),
    modelId: 'openai::gpt-6-sol',
    signal: new AbortController().signal,
    threadId: 'owner-thread',
  };
}

test('actual Main preserves a nondefault full intent and refuses CLI reduction without its intent owner', async () => {
  await workspace();
  const original = intent();
  const capabilities = productionDesktopCapabilities({}, async () => original.permissionPolicy);
  const captured = await capabilities.readConfiguration(request(original));
  try {
    expect(captured.durableConfiguration['intent']).toEqual(original);
  } finally {
    await captured.close();
  }
  let unexpected: Awaited<ReturnType<typeof capabilities.readConfiguration>> | undefined;
  try {
    await expect(
      capabilities
        .readConfiguration(
          request({
            kind: 'cli-workspace',
            version: 1,
            workspace: { instructions: 'inherit', rootIds: ['root-a'], skills: 'off' },
          })
        )
        .then((selection) => {
          unexpected = selection;
          return selection;
        })
    ).rejects.toThrow('ERR_CLI_WORKSPACE_OWNER_INTENT_UNAVAILABLE');
  } finally {
    await unexpected?.close();
  }
});

test('actual Main context reads never begin B after revocation while A is held', async () => {
  const { a, b } = await workspace();
  const read = fs.readFile.bind(fs);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: string[] = [];
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    const path = String(args[0]);
    if (path === join(a, 'AGENTS.md')) {
      entered.resolve();
      await release.promise;
    }
    if (path === join(b, 'AGENTS.md')) {
      observed.push(path);
    }
    return read(...args);
  });
  const configuration = {
    ...intent(),
    cliWorkspace: {
      instructions: 'inherit' as const,
      rootIds: ['root-a', 'root-b'],
      skills: 'off' as const,
    },
    workspaceContext: { ...intent().workspaceContext!, files: [] },
    workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
  };
  const capabilities = productionDesktopCapabilities({});
  const pending = capabilities.readConfiguration(request(configuration));
  const settled = pending.then(
    async (selection) => {
      await selection.close();
      return;
    },
    (cause: unknown) => cause
  );
  try {
    await entered.promise;
    roots = roots.filter((root) => root.id !== 'root-b');
  } finally {
    release.resolve();
  }
  expect(await settled).toBeInstanceOf(Error);
  expect(observed).toEqual([]);
});

function native() {
  const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
  const status: IndexerStatus = {
    authorizedCollectionIds: ['selected'],
    authorizedRootIds: ['root-a', 'root-b'],
    collectionReadiness: [{ embeddingSetId: 'selected', scanComplete: true }],
    embedding,
    kind: 'ready',
    queryPlan,
    rootReadiness: ['root-a', 'root-b'].map((rootId) => ({ rootId, scanComplete: true })),
    storeId: 'a'.repeat(64),
  };
  const result: IndexerSearchResult = {
    candidateCount: 1,
    candidatesTruncated: false,
    embedding,
    hits: [
      {
        chunkId: 'chunk-b',
        chunkIndex: 0,
        chunkSize: 384,
        chunkType: 'text',
        content: 'Unselected B marker',
        contentHash: 'c'.repeat(64),
        embeddingSetId: 'selected',
        endLine: 1,
        endOffset: 19,
        fileId: 'file-b',
        relativePath: 'b.txt',
        rootId: 'root-b',
        score: 0.1,
        sourcePath: join(roots[1]!.path, 'b.txt'),
        startLine: 1,
        startOffset: 0,
        tokenCount: 3,
      },
    ],
    scanLimited: false,
    storeId: 'a'.repeat(64),
    truncated: false,
  };
  const coverage: IndexSearchCapability['coverage'] = async () => ({
    collections: [{ ...counts, embeddingSetId: 'selected' }],
    embedding,
    roots: ['root-a', 'root-b'].map((rootId) => ({ ...counts, rootId })),
    storeId: result.storeId,
    totals: counts,
    vectorCoverageComplete: true,
  });
  const search = vi.fn<IndexSearchCapability['search']>(async (scope) => ({
    ...result,
    hits: scope.rootIds.length > 0 && !scope.rootIds.includes('root-b') ? [] : result.hits,
  }));
  const capability: IndexSearchCapability = {
    coverage,
    coverageBatch: async (requests) => ({
      coverage: await Promise.all(requests.map(coverage)),
      kind: 'current',
      status,
    }),
    grep: async (scope) => ({
      ...result,
      hits: scope.rootIds.length > 0 && !scope.rootIds.includes('root-b') ? [] : result.hits,
    }),
    rebuild: async () => undefined,
    search,
    status: async () => status,
  };
  return { capability, queryEmbedding: async () => Array.from({ length: 384 }, () => 0.1), search };
}
test.each([
  { mode: 'semantic', selected: ['root-a'], toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { mode: 'hybrid', selected: ['root-a'], toolId: NATIVE_TOOL_ID.hybridSearch },
  { mode: 'semantic', selected: [], toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { mode: 'hybrid', selected: [], toolId: NATIVE_TOOL_ID.hybridSearch },
])(
  'actual $mode adapter limits omitted-root collection retrieval to $selected',
  async ({ toolId, selected }) => {
    await workspace();
    const fixture = native();
    const capabilities = productionDesktopCapabilities({
      embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
      nativeIndexSearch: fixture.capability,
    });
    const captured = await capabilities.readConfiguration(
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: selected, skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      const tool = Object.values(captured.tools).find(
        (candidate) => candidate.permissionToolId === toolId
      );
      if (!tool) {
        throw new Error('Canonical retrieval tool was not admitted');
      }
      const result = await tool.execute(
        { embeddingSetId: 'selected', query: 'marker' },
        {
          runId: 'scope-run',
          signal: new AbortController().signal,
          threadId: 'owner-thread',
          toolCallId: 'scope-call',
        }
      );
      expect
        .soft(
          fixture.search.mock.calls.every(
            ([scope]) =>
              scope.rootIds.every((id) => selected.includes(id)) && scope.rootIds.length > 0
          )
        )
        .toBe(true);
      expect.soft(JSON.stringify(result)).not.toContain('Unselected B marker');
    } finally {
      await captured.close();
    }
  }
);
