import { MastraCompositeStore } from '@mastra/core/storage';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import { PgliteMemoryStore } from './memory-store';
import type { PgliteDatabase } from './types';
import { PgliteVectorStore } from './vector-store';

export interface PgliteMastraMemoryOptions {
  database: PgliteDatabase;
  embedder?: MastraEmbeddingModel<string> | string;
  id?: string;
  semanticRecall?: boolean;
}

export interface PgliteMastraMemoryResult {
  memory: Memory;
  storage: MastraCompositeStore;
  store: PgliteMemoryStore;
  vector: PgliteVectorStore;
}

export async function createPgliteMastraMemory({
  database,
  embedder,
  id = 'brainstrike-pglite-memory',
  semanticRecall = false,
}: PgliteMastraMemoryOptions): Promise<PgliteMastraMemoryResult> {
  if (semanticRecall && !embedder) {
    throw new Error('PGlite Mastra semantic recall requires an explicit embedder.');
  }

  const store = new PgliteMemoryStore({ database });
  await store.init();
  const storage = new MastraCompositeStore({
    id: `${id}-storage`,
    domains: { memory: store },
  });
  const vector = new PgliteVectorStore({ database, id: `${id}-vector` });
  const memory = new Memory({
    storage,
    vector,
    ...(embedder ? { embedder } : {}),
    options: {
      lastMessages: 40,
      semanticRecall,
      workingMemory: { enabled: true, scope: 'resource' },
      observationalMemory: {
        model: 'openai/gpt-5.4-mini',
        scope: 'thread',
      },
    },
  });

  return { memory, storage, store, vector };
}
