import type { ThreadSearchCoverage } from '@brainstrike/db';
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

/** The host's rows, rows with a vector, and rows whose last embedding failed recently. */
export interface HostSearchCoverage {
  readonly embedded: number;
  readonly errored: number;
  readonly rows: number;
}

/** The host's semantic-arm backlog, for this renderer's search embedder. */
export interface HostThreadSearchVectors {
  coverage(profile: ThreadSearchVectorProfile): Promise<HostSearchCoverage>;
  pending(
    profile: ThreadSearchVectorProfile,
    limit: number
  ): Promise<readonly HostSearchBacklogRow[]>;
  put(
    profile: ThreadSearchVectorProfile,
    rows: readonly (
      | {
          readonly seq: number;
          readonly sourceHash: string;
          readonly threadId: string;
          readonly vector: readonly number[];
        }
      | {
          readonly error: string;
          readonly seq: number;
          readonly sourceHash: string;
          readonly threadId: string;
        }
    )[]
  ): Promise<{ readonly failed: number; readonly stale: number; readonly stored: number }>;
}

/** History's coverage with the host's rows added, as the panel's one embedding progress. */
export function combineThreadSearchCoverage(
  history: ThreadSearchCoverage,
  host: HostSearchCoverage | null
): ThreadSearchCoverage {
  if (!host) {
    return history;
  }
  return {
    embeddableMessages: history.embeddableMessages + host.rows,
    embeddedMessages: history.embeddedMessages + host.embedded,
    erroredMessages: history.erroredMessages + host.errored,
    indexedMessages: history.indexedMessages + host.rows,
    totalMessages: history.totalMessages + host.rows,
  };
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return typeof error === 'string' && error.trim()
    ? error.trim()
    : `Non-Error value thrown (${String(error)})`;
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
 * none for a row whose text changed meanwhile. A row that fails to embed is
 * handed back with its error, as history marks `embedding_error`: the host
 * counts it as errored and keeps it out of the backlog until its retry window
 * passes.
 */
export async function embedPendingHostSearchRows(options: {
  readonly embedder: ThreadSearchEmbedder;
  readonly host: HostThreadSearchVectors;
  readonly limit: number;
  readonly modelInfo: EmbeddingSetModelInfo;
  readonly profile: ThreadSearchVectorProfile;
}): Promise<number> {
  const pending = await options.host.pending(options.profile, options.limit);
  const rows: Parameters<HostThreadSearchVectors['put']>[1][number][] = [];
  for (const row of pending) {
    const address = { seq: row.seq, sourceHash: row.sourceHash, threadId: row.threadId };
    try {
      rows.push({
        ...address,
        vector: await options.embedder.embedDocumentWithRecovery(options.modelInfo, row.text),
      });
    } catch (error) {
      rows.push({
        ...address,
        error: `Host thread message ${row.threadId}#${row.seq} embedding failed: ${errorDetail(error)}`,
      });
    }
  }
  if (rows.length > 0) {
    await options.host.put(options.profile, rows);
  }
  return pending.length;
}
