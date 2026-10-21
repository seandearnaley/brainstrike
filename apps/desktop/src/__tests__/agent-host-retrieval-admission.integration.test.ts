// @vitest-environment node
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type {
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { admissionCatalogFixture } from './fixtures/admission-catalog';
import { admitHostTools } from './fixtures/admitted-host-tools';
import { desktopAdmission } from './fixtures/desktop-admission';
import { capturedIntent } from './fixtures/desktop-admission-reads';

/** ADR 0026: the retrieval lane, offered only when Main's index can serve it. */
const RETRIEVAL = [
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
];
let directory = '';
const catalog = admissionCatalogFixture(() => [
  { displayName: 'A', id: 'root-a', path: join(directory, 'a') },
]);
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'bs-retrieval-admission-')));
  await fs.mkdir(join(directory, 'a'));
});
afterEach(async () => {
  await fs.rm(directory, { force: true, recursive: true });
});

const ready = {
  authorizedCollectionIds: ['collection'],
  authorizedRootIds: ['root-a'],
  kind: 'ready',
  rootReadiness: [{ rootId: 'root-a', scanComplete: true }],
  storeId: 'a'.repeat(64),
} as const;
const TEXT: IndexerStatus = { ...ready, embedding: { indexMode: 'text-only' } };
const VECTOR: IndexerStatus = {
  ...ready,
  embedding: {
    indexMode: 'vector-configured',
    profile: { dimensions: 384, dtype: 'q8', modelId: 'Xenova/all-MiniLM-L6-v2', tokenCap: 256 },
    profileHash: 'profile-hash',
  },
};
/** Main's index answering `status` alone: admission reads nothing else from it. */
function mainIndex(status: IndexerStatus): IndexSearchCapability {
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error('Admission reads only the index status'));
  return {
    coverage: unexpected,
    coverageBatch: unexpected,
    grep: unexpected,
    rebuild: unexpected,
    search: unexpected,
    status: async () => status,
  };
}

test.each([
  { mode: 'TEXT', offered: false, status: TEXT },
  { mode: 'VECTOR and ready', offered: true, status: VECTOR },
])(
  'a host run over Main’s platform connection is offered the retrieval tools only on a $mode index',
  async ({ offered, status }) => {
    const admitted = await admitHostTools(
      desktopAdmission({
        ...catalog.services,
        nativeIndexSearch: mainIndex(status),
        resolveForgeService: () => null,
        resolveWorktreeService: () => null,
      }),
      {
        configuration: {
          ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
          enabledNativeToolIds: [NATIVE_TOOL_ID.grepSearch, ...RETRIEVAL],
        },
        modelId: 'openai::gpt-6-sol',
        runId: 'host-run',
        signal: new AbortController().signal,
        threadId: 'host-thread',
      }
    );
    try {
      const ids = Object.values(admitted.tools).map((tool) => tool.permissionToolId);
      expect(ids).toContain(NATIVE_TOOL_ID.grepSearch);
      for (const id of RETRIEVAL) {
        expect(ids.includes(id)).toBe(offered);
      }
    } finally {
      await admitted.close();
    }
  }
);
