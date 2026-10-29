// @vitest-environment node
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { IndexerStatus } from '@brainstrike/indexing-contract/indexer-client';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  createDesktopRunAdmission,
  type DesktopAdmissionReads,
} from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';

/** Errors the admission logs, by logger scope. */
const logged = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (original) => {
  const actual = await original<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (scope: string) =>
      Object.assign(Object.create(actual.createLogger(scope)), {
        error: (...args: unknown[]) => logged(scope, ...args),
      }),
  };
});
beforeEach(() => {
  logged.mockClear();
});
const UNREADABLE = 'Workspace index status is unreadable; the retrieval tools are not offered';

/** ADR 0026: the retrieval lane, offered only when Main's index can serve it. */
const RETRIEVAL = [
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
];
const alpha = { displayName: 'alpha', path: '/workspace/alpha', rootId: 'root-a' };
const worktree = { displayName: 'alpha-wt', path: '/workspace/alpha-wt', rootId: 'root-wt' };

const vector = {
  indexMode: 'vector-configured',
  profile: {
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    provider: 'openai',
  },
  profileHash: 'profile-hash',
} as const;
function ready(overrides: Partial<Extract<IndexerStatus, { kind: 'ready' }>> = {}): IndexerStatus {
  return {
    authorizedCollectionIds: ['collection'],
    authorizedRootIds: ['root-a'],
    embedding: vector,
    kind: 'ready',
    rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
    storeId: 'a'.repeat(64),
    ...overrides,
  };
}

/** A send that enables grep, the retrieval tools and readWorkspaceContext. */
function send(
  signal = new AbortController().signal,
  binding?: HostRunAdmissionRequest['workspaceBinding']
): HostRunAdmissionRequest {
  return {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      enabledNativeToolIds: [
        NATIVE_TOOL_ID.grepSearch,
        NATIVE_TOOL_ID.readWorkspaceContext,
        ...RETRIEVAL,
      ],
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal,
    threadId: 'host-thread',
    ...(binding ? { workspaceBinding: binding } : {}),
  };
}

async function offered(
  reads: Partial<DesktopAdmissionReads>,
  request: HostRunAdmissionRequest = send()
): Promise<{ readonly ids: readonly string[]; readonly system: string | undefined }> {
  const selected = await createDesktopRunAdmission(
    mainReads({ liveWorkspaceRoots: async () => [alpha], ...reads }),
    async () => undefined
  ).readConfiguration(request);
  try {
    return {
      ids: Object.values(selected.tools).map((tool) => tool.permissionToolId ?? ''),
      system: selected.system,
    };
  } finally {
    await selected.close();
  }
}

test('a TEXT-mode index offers grep and no retrieval tool, and the instructions name none', async () => {
  const { ids, system } = await offered({
    indexStatus: async () => ready({ embedding: { indexMode: 'text-only' } }),
  });
  expect(ids).toContain(NATIVE_TOOL_ID.grepSearch);
  for (const id of RETRIEVAL) {
    expect(ids).not.toContain(id);
  }
  expect(system).not.toMatch(/hybridSearch|queryEmbeddingSpace|listEmbeddingSpaces/u);
});

test('an index that is not ready offers no retrieval tool', async () => {
  const { ids } = await offered({
    indexStatus: async () => ({
      kind: 'unavailable',
      phase: 'preparing',
      reason: 'Native indexing is preparing.',
    }),
  });
  expect(ids).toContain(NATIVE_TOOL_ID.grepSearch);
  for (const id of RETRIEVAL) {
    expect(ids).not.toContain(id);
  }
});

test('a ready VECTOR index with a saved collection over the thread’s folder offers the retrieval tools', async () => {
  const { ids, system } = await offered({ indexStatus: async () => ready() });
  expect(ids).toEqual(expect.arrayContaining([NATIVE_TOOL_ID.grepSearch, ...RETRIEVAL]));
  expect(system).toMatch(/queryEmbeddingSpace/u);
});

test('a ready VECTOR index without an authorized collection offers no retrieval tool', async () => {
  const { ids } = await offered({
    indexStatus: async () => ready({ authorizedCollectionIds: [] }),
  });
  for (const id of RETRIEVAL) {
    expect(ids).not.toContain(id);
  }
});

test('a worktree-mode thread whose folders the index leaves out offers no retrieval tool', async () => {
  // BST-2271: the index authorizes the main checkout, not the thread's unindexed worktree.
  const { ids } = await offered(
    {
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: [worktree],
      }),
      indexStatus: async () => ready(),
      liveWorkspaceRoots: async () => [alpha, worktree],
    },
    send(undefined, { operatingRootDisplayName: 'alpha-wt', operatingRootId: 'root-wt' })
  );
  expect(ids).toContain(NATIVE_TOOL_ID.grepSearch);
  for (const id of RETRIEVAL) {
    expect(ids).not.toContain(id);
  }
});

test('readWorkspaceContext reads the disk and stays offered on a TEXT-mode index', async () => {
  const { ids } = await offered({
    indexStatus: async () => ready({ embedding: { indexMode: 'text-only' } }),
  });
  expect(ids).toContain(NATIVE_TOOL_ID.readWorkspaceContext);
});

test('an unreadable index status offers no retrieval tool and never fails the run', async () => {
  const { ids } = await offered({
    indexStatus: async () => {
      throw new Error('Native read acquired a retired or foreign writer.');
    },
  });
  expect(ids).toContain(NATIVE_TOOL_ID.grepSearch);
  for (const id of RETRIEVAL) {
    expect(ids).not.toContain(id);
  }
  expect(logged).toHaveBeenCalledWith('DesktopRunAdmission', UNREADABLE, {
    cause: expect.objectContaining({
      message: 'Native read acquired a retired or foreign writer.',
    }),
  });
});

test('a run cancelled during the index status read is refused, and logs no index fault', async () => {
  const controller = new AbortController();
  await expect(
    offered(
      {
        indexStatus: async () => {
          controller.abort(new Error('run cancelled'));
          throw controller.signal.reason;
        },
      },
      send(controller.signal)
    )
  ).rejects.toThrow('run cancelled');
  expect(logged).not.toHaveBeenCalledWith('DesktopRunAdmission', UNREADABLE, expect.anything());
});
