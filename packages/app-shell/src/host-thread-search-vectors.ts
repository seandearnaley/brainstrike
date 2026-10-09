import {
  quantizesUnpinnedLoad,
  unpinnedEmbeddingDType,
} from '@brainstrike/embeddings/inference-plan';
import { parseEmbeddingProviderModelKey } from '@brainstrike/indexing-contract';
import type { EmbedderRuntime, EmbeddingSetModelInfo } from '@brainstrike/vector-management';
import type { ThreadSearchEmbedder } from './thread-search-embedding';

/**
 * The identity of the embedder that computed a vector, as the host's state
 * index keys search vectors: a local model loads with the shared unpinned
 * dtype rule on its runtime's device, so a changed device is a new profile.
 */
export type ThreadSearchVectorProfile = Readonly<Record<string, number | string>>;

/** One host conversation row without a vector under a profile. */
export interface HostSearchBacklogRow {
  readonly seq: number;
  readonly sourceHash: string;
  readonly text: string;
  readonly threadId: string;
}

/** The host's semantic-arm backlog, for this renderer's search embedder. */
export interface HostThreadSearchVectors {
  pending(
    profile: ThreadSearchVectorProfile,
    limit: number
  ): Promise<readonly HostSearchBacklogRow[]>;
  put(
    profile: ThreadSearchVectorProfile,
    rows: readonly {
      readonly seq: number;
      readonly sourceHash: string;
      readonly threadId: string;
      readonly vector: readonly number[];
    }[]
  ): Promise<{ readonly stale: number; readonly stored: number }>;
}

export function threadSearchVectorProfile(
  info: EmbeddingSetModelInfo,
  runtime: EmbedderRuntime
): ThreadSearchVectorProfile {
  if (runtime === 'hosted') {
    const parsed = parseEmbeddingProviderModelKey(info.modelKey);
    if (!parsed) {
      throw new Error(`Thread search embedding model key is not a provider key: ${info.modelKey}`);
    }
    return {
      dimensions: info.dimensions,
      distance: 'cosine',
      modelId: parsed.modelId,
      provider: parsed.provider,
    };
  }
  if (!info.modelConfig) {
    throw new Error(`Local thread search embedding has no model config: ${info.modelKey}`);
  }
  return {
    dimensions: info.dimensions,
    distance: 'cosine',
    dtype: unpinnedEmbeddingDType(runtime, quantizesUnpinnedLoad(info.modelConfig)),
    modelId: info.modelConfig.id,
    provider: 'local',
  };
}

/**
 * Embeds one bounded batch of the host's backlog, one row at a time as the
 * history backlog is, then hands the vectors to the host; the host stores
 * none for a row whose text changed meanwhile. A row that fails to embed
 * fails the pass after the others are stored, so a broken embedder stops the
 * drain instead of retrying the same rows.
 */
export async function embedPendingHostSearchRows(options: {
  readonly embedder: ThreadSearchEmbedder;
  readonly host: HostThreadSearchVectors;
  readonly limit: number;
  readonly modelInfo: EmbeddingSetModelInfo;
  readonly profile: ThreadSearchVectorProfile;
}): Promise<number> {
  const pending = await options.host.pending(options.profile, options.limit);
  const vectors: {
    seq: number;
    sourceHash: string;
    threadId: string;
    vector: readonly number[];
  }[] = [];
  const failures: unknown[] = [];
  for (const row of pending) {
    try {
      vectors.push({
        seq: row.seq,
        sourceHash: row.sourceHash,
        threadId: row.threadId,
        vector: await options.embedder.embedDocumentWithRecovery(options.modelInfo, row.text),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (vectors.length > 0) {
    await options.host.put(options.profile, vectors);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} host thread messages failed to embed`);
  }
  return pending.length;
}
