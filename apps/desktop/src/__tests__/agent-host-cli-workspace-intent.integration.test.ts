// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest, HostTool, HostToolContext } from '@brainstrike/agent-host';
import { HostRunSnapshotSchema } from '@brainstrike/agent-host/protocol';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type {
  IndexerSearchResult,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type {
  DesktopHostIntent,
  DesktopHostModelProjection,
} from '../agent-host-platform/desktop-host-intent';
import { admitHostTools } from './fixtures/admitted-host-tools';
import {
  INDEX_UNAVAILABLE,
  OUTSIDE_CHUNK,
  OUTSIDE_FILE,
  UNAVAILABLE,
} from './fixtures/guarded-retrieval-refusals';

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
  hybrid: vi.fn(),
  query: vi.fn(),
  semantic: vi.fn(),
}));
const renderer = vi.hoisted(() => ({
  enforce: true,
  intent: vi.fn<() => DesktopHostIntent>(),
  project: vi.fn(),
}));
vi.mock('@brainstrike/app-shell', () => ({
  buildAgentLoopSettings: () => renderer.intent().agentLoop,
  buildAssistantMemoryOptions: () => renderer.intent().memoryOptions,
  buildDraftRuntimeForProvider: renderer.project,
  toRuntimeWorkspaceContext: () => renderer.intent().workspaceContext ?? null,
}));
vi.mock('@brainstrike/app-state/stores/assistant-preferences-store', () => ({
  useAssistantPreferencesStore: {
    getState: () => ({
      providerSettings: { openai: { temperature: 0.12 } },
      selectedModel: 'openai::gpt-6-sol',
    }),
  },
}));
vi.mock('@brainstrike/assistant-data', async (original) => ({
  ...(await original<typeof import('@brainstrike/assistant-data')>()),
  useAssistantThreadStore: {
    getState: () => ({
      draftRuntimeByThreadId: {
        'owner-thread': {
          model: 'gpt-6-sol',
          modelSettings: { maxOutputTokens: 111 },
          provider: 'openai',
          providerOptions: { openai: { reasoningEffort: 'medium' } },
          providerSettings: { openai: { temperature: 0.22 } },
        },
      },
    }),
  },
}));
vi.mock('@brainstrike/app-state/stores/assistant-memory-preferences-store', () => ({
  useAssistantMemoryPreferencesStore: {
    getState: () => ({ getRuntimeMemorySettings: () => renderer.intent().memorySettings }),
  },
}));
vi.mock('@brainstrike/app-state/stores/native-tool-preferences-store', () => ({
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (id: string) => renderer.intent().enabledNativeToolIds.includes(id),
    }),
  },
}));
vi.mock('@brainstrike/app-state/stores/permission-policy-store', () => ({
  getPermissionToolGateSnapshotInput: () => ({
    ...renderer.intent().permissionPolicy,
    enforce: renderer.enforce,
  }),
}));
vi.mock('@brainstrike/app-state/stores/subagent-personas-store', () => ({
  useSubagentPersonasStore: { getState: () => renderer.intent().subagents },
}));
vi.mock('@brainstrike/app-state/stores/assistant-subagent-preferences-store', () => ({
  useAssistantSubagentPreferencesStore: {
    getState: () => ({ settings: renderer.intent().subagents?.settings }),
  },
}));
vi.mock('@brainstrike/app-state/stores/skills-preferences-store', () => ({
  buildSkillsContextRequest: () => renderer.intent().skillsPreference,
  useSkillsPreferencesStore: { getState: () => ({}) },
}));
vi.mock('@brainstrike/app-state/stores/workspace-instructions-preferences-store', () => ({
  useWorkspaceInstructionsPreferencesStore: {
    getState: () => renderer.intent().workspaceInstructionsPreference,
  },
}));
vi.mock('@brainstrike/file-explorer-ui/preview', () => ({
  useWorkspaceContextCurationStore: { getState: () => ({ contextSnapshot: null }) },
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
  FileChunkRepository: class {
    searchSimilar = owner.semantic;
  },
  FileRecordRepository: class {
    findByIds = owner.files;
  },
  HybridSearchService: class {
    search = owner.hybrid;
  },
}));

import { productionDesktopCapabilities } from '../agent-host-platform/production-desktop-capabilities';
import { readDesktopHostConfiguration } from '../renderer/desktop-host-configuration';
import { desktopHostIntentFixture as intent } from './fixtures/desktop-host-intent';

const directories: string[] = [];
let roots: { id: string; displayName: string; path: string }[] = [];
let fileOwners: { id: string; rootId: string; rootName: string }[] = [];
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
  renderer.enforce = true;
  renderer.intent.mockImplementation(intent);
  renderer.project.mockImplementation(() => ({
    ...intent().modelConfiguration,
    providerSettings: { openai: { apiKey: 'synthetic-private-projection-marker' } },
  }));
  vi.stubGlobal('fetch', owner.fetch);
  fileOwners = [{ id: 'file-b', rootId: 'root-b', rootName: 'B' }];
  owner.files.mockResolvedValue([
    { id: 'file-b', name: 'b.txt', path: 'b.txt', rootId: 'root-b', tokenCount: 3 },
  ]);
  owner.semantic.mockResolvedValue([]);
  owner.hybrid.mockResolvedValue({
    metadata: { ftsResultCount: 0, fusedResultCount: 0, totalMs: 0, vectorResultCount: 0 },
    results: [],
  });
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
      return { rows: fileOwners };
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
function request(configuration: unknown): HostRunAdmissionRequest {
  return {
    configuration: z.record(z.string(), z.json()).parse(configuration),
    modelId: 'openai::gpt-6-sol',
    signal: new AbortController().signal,
    threadId: 'owner-thread',
  };
}

function admittedRetrieval(tools: Record<string, HostTool>, toolId: string): HostTool {
  const tool = Object.values(tools).find((candidate) => candidate.permissionToolId === toolId);
  if (!tool) {
    throw new Error('Canonical retrieval tool was not admitted');
  }
  return tool;
}
function execution(): HostToolContext {
  return {
    // Core's capabilities for a host tool call; a retrieval read never edits.
    edits: { track: async () => Promise.reject(new Error('A host read never edits')) },
    runId: 'scope-run',
    signal: new AbortController().signal,
    state: { entries: () => [], read: async () => undefined, update: async () => undefined },
    threadId: 'owner-thread',
    toolCallId: 'scope-call',
  };
}

function cliInput(rootIds = ['root-a']) {
  return {
    kind: 'cli-workspace',
    version: 1,
    workspace: { instructions: 'off', rootIds, skills: 'off' },
  };
}

test.for([false, true])(
  'actual renderer capture retains every field and option precedence (projection=%s)',
  (projected) => {
    const original = intent();
    original.enabledNativeToolIds = [NATIVE_TOOL_ID.askUser];
    renderer.intent.mockReturnValue(original);
    renderer.enforce = false;
    const projection: DesktopHostModelProjection | undefined = projected
      ? {
          agentLoop: { inputTokenLimit: 6789, maxSteps: 7 },
          model: 'gpt-6-astra',
          modelSettings: { maxOutputTokens: 222, temperature: 0.44 },
          provider: 'openai',
          providerOptions: { openai: { reasoningEffort: 'high' } },
        }
      : undefined;
    const captured = readDesktopHostConfiguration('owner-thread', 'root-a', projection);
    expect(captured).toEqual({
      ...original,
      agentLoop: projection?.agentLoop ?? original.agentLoop,
      modelConfiguration: {
        model: projection?.model ?? original.modelConfiguration.model,
        modelSettings: projection?.modelSettings ?? { maxOutputTokens: 111 },
        provider: 'openai',
        providerOptions: projection?.providerOptions ?? { openai: { reasoningEffort: 'medium' } },
      },
      permissionPolicy: { ...original.permissionPolicy, yolo: true },
      selectionFolderId: 'root-a',
    });
    expect(renderer.project).toHaveBeenCalledWith({
      model: 'gpt-6-sol',
      provider: 'openai',
      providerSettingsMap: { openai: { temperature: 0.22 } },
    });
    expect(JSON.stringify(captured)).not.toContain('synthetic-private-projection-marker');
  }
);

test.for([{ rootIds: ['root-a'] }, { rootIds: [] }])(
  'actual Main trusted full intent owner preserves all settings when reducing to $rootIds',
  async ({ rootIds }) => {
    await workspace();
    const original = intent();
    original.selectionFolderId = 'root-b';
    original.skillsPreference = {
      disabledSkillKeys: ['root:root-b:disabled'],
      masterEnabled: true,
    };
    original.workspaceInstructionsPreference = {
      masterEnabled: true,
      oversizedOptInByRootId: { 'root-a': true, 'root-b': true },
    };
    original.workspaceContext!.files.push({
      ...original.workspaceContext!.files[0]!,
      rootId: 'root-b',
    });
    const unchanged = structuredClone(original);
    const readOwner = vi.fn(async () => original);
    const capabilities = productionDesktopCapabilities({}, undefined, readOwner);
    const input = request(cliInput(rootIds));
    const captured = await capabilities.readConfiguration(input);
    try {
      const { selectionFolderId: _selection, ...retained } = original;
      expect(captured.durableConfiguration['intent']).toEqual({
        ...retained,
        cliWorkspace: cliInput(rootIds).workspace,
        skillsPreference: { ...original.skillsPreference, masterEnabled: false },
        workspaceContext: {
          ...original.workspaceContext,
          files: original.workspaceContext!.files.filter((file) => rootIds.includes(file.rootId!)),
        },
        workspaceInstructionsPreference: {
          masterEnabled: false,
          oversizedOptInByRootId: rootIds.length ? { 'root-a': true } : {},
        },
      });
      expect(captured.configuration).toEqual(original.modelConfiguration);
      expect(captured.maxSteps).toBe(3);
      expect(captured.inputTokenLimit).toBe(7000);
      expect(captured.memory.options).toEqual(original.memoryOptions);
      expect(readOwner).toHaveBeenCalledExactlyOnceWith(input);
      expect(original).toEqual(unchanged);
    } finally {
      await captured.close();
    }
  }
);

test.for([undefined, null, { modelConfiguration: { model: 'gpt-6-sol', provider: 'openai' } }])(
  'actual Main refuses absent or incomplete trusted owner output without substituting defaults (%j)',
  async (output) => {
    await workspace();
    const readOwner = vi.fn(async () => output);
    const capabilities = productionDesktopCapabilities({}, undefined, readOwner);
    await expect(capabilities.readConfiguration(request(cliInput()))).rejects.toThrow();
    expect(readOwner).toHaveBeenCalledOnce();
    expect(owner.query.mock.calls.some(([sql]) => String(sql).includes('FROM roots'))).toBe(false);
  }
);

test('actual Main refuses a trusted owner model mismatch before root acquisition', async () => {
  await workspace();
  const original = intent();
  original.modelConfiguration.model = 'gpt-6-astra';
  const capabilities = productionDesktopCapabilities({}, undefined, async () => original);
  await expect(capabilities.readConfiguration(request(cliInput()))).rejects.toThrow(
    'Captured settings do not belong'
  );
  expect(owner.query.mock.calls.some(([sql]) => String(sql).includes('FROM roots'))).toBe(false);
});

test('actual Main rejects caller-supplied owner intent in the strict CLI envelope', async () => {
  await workspace();
  const readOwner = vi.fn(async () => intent());
  const capabilities = productionDesktopCapabilities({}, undefined, readOwner);
  await expect(
    capabilities.readConfiguration(request({ ...cliInput(), ownerIntent: intent() }))
  ).rejects.toThrow();
  expect(readOwner).not.toHaveBeenCalled();
});

test('actual Main joins a held owner read and refuses after admission is aborted', async () => {
  await workspace();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<DesktopHostIntent>();
  const controller = new AbortController();
  const readOwner = vi.fn(() => {
    entered.resolve();
    return release.promise;
  });
  const capabilities = productionDesktopCapabilities({}, undefined, readOwner);
  const pending = capabilities.readConfiguration({
    ...request(cliInput()),
    signal: controller.signal,
  });
  const settled = pending.then(
    async (selection) => {
      await selection.close();
      return;
    },
    (cause: unknown) => cause
  );
  try {
    await entered.promise;
    controller.abort(new Error('Owner capture aborted'));
  } finally {
    release.resolve(intent());
  }
  expect(await settled).toEqual(new Error('Owner capture aborted'));
  expect(owner.query.mock.calls.some(([sql]) => String(sql).includes('FROM roots'))).toBe(false);
});

test('actual Main recovery retains committed full intent without rereading current preferences', async () => {
  await workspace();
  const readOwner = vi.fn(async () => intent());
  const capabilities = productionDesktopCapabilities({}, undefined, readOwner);
  const input = request(cliInput());
  const admitted = await capabilities.readConfiguration(input);
  const snapshot = HostRunSnapshotSchema.parse({
    configuration: admitted.durableConfiguration,
    maxSteps: admitted.maxSteps,
    toolIdentities: {},
  });
  await admitted.close();
  readOwner.mockImplementation(async () => {
    throw new Error('Recovery must not consult current preferences');
  });
  const recovered = await capabilities.readConfiguration({ ...input, snapshot });
  try {
    expect(recovered.durableConfiguration).toEqual(snapshot.configuration);
    expect(readOwner).toHaveBeenCalledOnce();
  } finally {
    await recovered.close();
  }
  await expect(
    capabilities.readConfiguration({ ...request(cliInput(['root-a', 'root-b'])), snapshot })
  ).rejects.toThrow('CLI workspace recovery does not match its committed selection');
  expect(readOwner).toHaveBeenCalledOnce();
});

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
  const coverage: IndexSearchCapability['coverage'] = async (scope) => ({
    ...(scope.collectionId === undefined
      ? {}
      : { collections: [{ ...counts, embeddingSetId: scope.collectionId }] }),
    embedding,
    roots: scope.rootIds.map((rootId) => ({ ...counts, rootId })),
    storeId: result.storeId,
    totals:
      scope.collectionId === undefined
        ? {
            chunks: scope.rootIds.length,
            indexedFiles: scope.rootIds.length,
            missingVectors: 0,
            vectors: scope.rootIds.length,
          }
        : counts,
    vectorCoverageComplete: true,
  });
  const search = vi.fn<IndexSearchCapability['search']>(async (scope) => ({
    ...result,
    hits: scope.rootIds.length > 0 && !scope.rootIds.includes('root-b') ? [] : result.hits,
  }));
  const grep = vi.fn<IndexSearchCapability['grep']>(async (scope) => ({
    ...result,
    hits: scope.rootIds.length > 0 && !scope.rootIds.includes('root-b') ? [] : result.hits,
  }));
  const coverageBatch = vi.fn<IndexSearchCapability['coverageBatch']>(async (requests) => ({
    coverage: await Promise.all(requests.map(coverage)),
    kind: 'current',
    status,
  }));
  const capability: IndexSearchCapability = {
    coverage,
    coverageBatch,
    grep,
    rebuild: async () => undefined,
    search,
    status: async () => status,
  };
  return {
    capability,
    coverageBatch,
    grep,
    queryEmbedding: vi.fn(async () => Array.from({ length: 384 }, () => 0.1)),
    result,
    search,
  };
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
    const admitted = await admitHostTools(
      capabilities,
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: selected, skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      const tool = admittedRetrieval(admitted.tools, toolId);
      const result = tool.execute({ embeddingSetId: 'selected', query: 'marker' }, execution());
      if (selected.length === 0) {
        await expect(result).resolves.toMatchObject(UNAVAILABLE);
        expect(fixture.search).not.toHaveBeenCalled();
        expect(fixture.grep).not.toHaveBeenCalled();
        expect(fixture.coverageBatch).not.toHaveBeenCalled();
        expect(fixture.queryEmbedding).not.toHaveBeenCalled();
        return;
      }
      const output = await result;
      expect(fixture.search).toHaveBeenCalled();
      expect
        .soft(
          fixture.search.mock.calls.every(
            ([scope]) =>
              scope.rootIds.every((id) => selected.includes(id)) && scope.rootIds.length > 0
          )
        )
        .toBe(true);
      expect(fixture.search.mock.calls.every(([scope]) => scope.collectionId === undefined)).toBe(
        true
      );
      expect.soft(JSON.stringify(output)).not.toContain('Unselected B marker');
    } finally {
      await admitted.close();
    }
  }
);

test.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch])(
  'actual %s adapter rejects unselected content returned by its query capability',
  async (toolId) => {
    await workspace();
    const fixture = native();
    fixture.search.mockResolvedValue(fixture.result);
    const capabilities = productionDesktopCapabilities({
      embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
      nativeIndexSearch: fixture.capability,
    });
    const admitted = await admitHostTools(
      capabilities,
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: ['root-a'], skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      await expect(
        admittedRetrieval(admitted.tools, toolId).execute(
          { embeddingSetId: 'selected', query: 'marker' },
          execution()
        )
      ).resolves.toMatchObject(OUTSIDE_CHUNK);
      expect(fixture.search).toHaveBeenCalledWith(expect.objectContaining({ rootIds: ['root-a'] }));
    } finally {
      await admitted.close();
    }
  }
);

test.each([
  { selected: ['root-a'], toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { selected: ['root-a'], toolId: NATIVE_TOOL_ID.hybridSearch },
  { selected: [], toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { selected: [], toolId: NATIVE_TOOL_ID.hybridSearch },
])(
  'a host $toolId without Main’s index refuses for $selected and never reaches the PG adapter',
  async ({ selected, toolId }) => {
    await workspace();
    const fixture = native();
    const admitted = await admitHostTools(
      productionDesktopCapabilities({
        embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
      }),
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: selected, skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      const result = admittedRetrieval(admitted.tools, toolId).execute(
        { embeddingSetId: 'selected', query: 'marker' },
        execution()
      );
      if (selected.length === 0) {
        await expect(result).resolves.toMatchObject(UNAVAILABLE);
        expect(owner.query.mock.calls.some(([sql]) => String(sql).includes('embedding_sets'))).toBe(
          false
        );
        expect(owner.hybrid).not.toHaveBeenCalled();
        expect(owner.semantic).not.toHaveBeenCalled();
        expect(fixture.queryEmbedding).not.toHaveBeenCalled();
        return;
      }
      // The host reads only Main's workspace index; it has no PG similarity path.
      await expect(result).resolves.toMatchObject(INDEX_UNAVAILABLE);
      expect(owner.hybrid).not.toHaveBeenCalled();
      expect(owner.semantic).not.toHaveBeenCalled();
    } finally {
      await admitted.close();
    }
  }
);

test.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch])(
  'a host %s without Main’s index refuses before PG could return an unselected root’s file',
  async (toolId) => {
    await workspace();
    const fixture = native();
    const chunk = {
      chunkIndex: 0,
      content: 'Unselected B marker',
      embeddingSetId: 'selected',
      endLine: 1,
      endOffset: 'Unselected B marker'.length,
      fileRecordId: 'file-b',
      id: 'chunk-b',
      startLine: 1,
      startOffset: 0,
      tokenCount: 3,
    };
    owner.semantic.mockResolvedValue([{ chunk, rank: 1, similarity: 0.9 }]);
    owner.hybrid.mockResolvedValue({
      metadata: { ftsResultCount: 1, fusedResultCount: 1, totalMs: 0, vectorResultCount: 1 },
      results: [{ chunk, position: 1, rrfScore: 0.1, sourceCount: 2 }],
    });
    const admitted = await admitHostTools(
      productionDesktopCapabilities({
        embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
      }),
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: ['root-a'], skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      await expect(
        admittedRetrieval(admitted.tools, toolId).execute(
          { embeddingSetId: 'selected', query: 'marker' },
          execution()
        )
      ).resolves.toMatchObject(INDEX_UNAVAILABLE);
      expect(owner.hybrid).not.toHaveBeenCalled();
      expect(owner.semantic).not.toHaveBeenCalled();
    } finally {
      await admitted.close();
    }
  }
);

test.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch])(
  'actual %s ordinary Desktop adapter retains its original collection query',
  async (toolId) => {
    await workspace();
    const fixture = native();
    const admitted = await admitHostTools(
      productionDesktopCapabilities({
        embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
        nativeIndexSearch: fixture.capability,
      }),
      request({
        ...intent(),
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      await admittedRetrieval(admitted.tools, toolId).execute(
        { embeddingSetId: 'selected', query: 'marker' },
        execution()
      );
      expect(fixture.search).toHaveBeenCalledWith(
        expect.objectContaining({ collectionId: 'selected', rootIds: [] })
      );
    } finally {
      await admitted.close();
    }
  }
);

test.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch])(
  'actual %s native adapter rejects a hit whose catalog file belongs to an unselected root',
  async (toolId) => {
    const paths = await workspace();
    const fixture = native();
    const result = {
      ...fixture.result,
      hits: [
        {
          ...fixture.result.hits[0]!,
          rootId: 'root-a',
          sourcePath: join(paths.a, 'b.txt'),
        },
      ],
    };
    fixture.search.mockResolvedValue(result);
    fixture.grep.mockResolvedValue(result);
    const admitted = await admitHostTools(
      productionDesktopCapabilities({
        embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
        nativeIndexSearch: fixture.capability,
      }),
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: ['root-a'], skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      await expect(
        admittedRetrieval(admitted.tools, toolId).execute(
          { embeddingSetId: 'selected', query: 'marker' },
          execution()
        )
      ).resolves.toMatchObject(OUTSIDE_FILE);
      expect(fixture.search).toHaveBeenCalled();
    } finally {
      await admitted.close();
    }
  }
);

test.each([
  { backend: 'native', toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { backend: 'native', toolId: NATIVE_TOOL_ID.hybridSearch },
  { backend: 'pg', toolId: NATIVE_TOOL_ID.queryEmbeddingSpace },
  { backend: 'pg', toolId: NATIVE_TOOL_ID.hybridSearch },
])(
  'actual $backend $toolId adapter: Main’s index returns valid selected-root content; PG alone refuses',
  async ({ backend, toolId }) => {
    const paths = await workspace();
    const fixture = native();
    const content = 'Selected A marker';
    const result = {
      ...fixture.result,
      hits: [
        {
          ...fixture.result.hits[0]!,
          content,
          contentHash: createHash('sha256').update(content).digest('hex'),
          endOffset: content.length,
          fileId: 'file-a',
          relativePath: 'a.txt',
          rootId: 'root-a',
          sourcePath: join(paths.a, 'a.txt'),
        },
      ],
    };
    fixture.search.mockResolvedValue(result);
    fixture.grep.mockResolvedValue(result);
    fileOwners = [{ id: 'file-a', rootId: 'root-a', rootName: 'A' }];
    owner.files.mockResolvedValue([
      { id: 'file-a', name: 'a.txt', path: 'a.txt', rootId: 'root-a', tokenCount: 3 },
    ]);
    const chunk = {
      chunkIndex: 0,
      content,
      embeddingSetId: 'selected',
      endLine: 1,
      endOffset: content.length,
      fileRecordId: 'file-a',
      id: 'chunk-a',
      startLine: 1,
      startOffset: 0,
      tokenCount: 3,
    };
    owner.semantic.mockResolvedValue([{ chunk, rank: 1, similarity: 0.9 }]);
    owner.hybrid.mockResolvedValue({
      metadata: { ftsResultCount: 1, fusedResultCount: 1, totalMs: 0, vectorResultCount: 1 },
      results: [{ chunk, position: 1, rrfScore: 0.1, sourceCount: 2 }],
    });
    const admitted = await admitHostTools(
      productionDesktopCapabilities({
        embeddingHostManager: { queryEmbedding: fixture.queryEmbedding },
        ...(backend === 'native' ? { nativeIndexSearch: fixture.capability } : {}),
      }),
      request({
        ...intent(),
        cliWorkspace: { instructions: 'off', rootIds: ['root-a'], skills: 'off' },
        enabledNativeToolIds: [toolId],
        workspaceContext: { ...intent().workspaceContext!, files: [] },
      })
    );
    try {
      const output = await admittedRetrieval(admitted.tools, toolId).execute(
        { embeddingSetId: 'selected', query: 'marker' },
        execution()
      );
      if (backend === 'pg') {
        // Valid PG content is never read: the host has no PG similarity path.
        expect(output).toMatchObject(INDEX_UNAVAILABLE);
        expect(owner.hybrid).not.toHaveBeenCalled();
        expect(owner.semantic).not.toHaveBeenCalled();
        return;
      }
      expect(JSON.stringify(output)).toContain(content);
      expect(JSON.stringify(output)).not.toContain('Unselected B marker');
    } finally {
      await admitted.close();
    }
  }
);
