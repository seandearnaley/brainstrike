import type { ThreadSearchEmbeddingProfile, ThreadSearchRepository } from '@brainstrike/db';
import type {
  EmbeddingSetModelInfo,
  UseSearchEmbedderResult,
} from '@brainstrike/vector-management';

export type ThreadSearchEmbeddingRepository = Pick<
  ThreadSearchRepository,
  'getEmbeddingProfile' | 'listNeedingEmbedding' | 'markEmbeddingError' | 'storeEmbedding'
>;

export type ThreadSearchEmbedder = Pick<
  UseSearchEmbedderResult,
  'embedDocumentWithRecovery' | 'embedQueryWithRecovery'
>;

export type ThreadMessageEmbeddingOutcome =
  | {
      readonly messageId: string;
      readonly status: 'embedded' | 'stale';
    }
  | {
      readonly error: string;
      readonly messageId: string;
      readonly status: 'error';
    };

interface ThreadSearchEmbeddingDependencies {
  readonly embedder: ThreadSearchEmbedder;
  /** Backlog rows embedded per pass (bounded; the next pass continues). */
  readonly limit: number;
  readonly modelInfo: EmbeddingSetModelInfo;
  readonly repository: ThreadSearchEmbeddingRepository;
}

function assertModelMatchesProfile(
  profile: ThreadSearchEmbeddingProfile,
  modelInfo: EmbeddingSetModelInfo
): void {
  if (profile.modelKey === modelInfo.modelKey && profile.dimensions === modelInfo.dimensions) {
    if (!modelInfo.modelConfig || modelInfo.modelConfig.id === profile.modelId) {
      return;
    }
    throw new Error(
      `Thread search embedding model config does not match profile "${profile.id}": expected ${profile.modelId}, received ${modelInfo.modelConfig.id}.`
    );
  }
  throw new Error(
    `Thread search embedding model does not match profile "${profile.id}": expected ${profile.modelKey} (${profile.dimensions} dimensions), received ${modelInfo.modelKey} (${modelInfo.dimensions} dimensions).`
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return `Non-Error value thrown (${String(error)})`;
}

/**
 * Embeds one bounded batch of pending thread-message index rows, one at a
 * time (mirrors `embedPendingPromptItems`): sequential execution avoids
 * contending for the local embedding runtime, and the content-hash CAS write
 * discards a result whose source text changed mid-flight instead of storing
 * a stale vector.
 */
export async function embedPendingThreadMessages({
  embedder,
  limit,
  modelInfo,
  repository,
}: ThreadSearchEmbeddingDependencies): Promise<ThreadMessageEmbeddingOutcome[]> {
  const profile = await repository.getEmbeddingProfile();
  assertModelMatchesProfile(profile, modelInfo);
  const pending = await repository.listNeedingEmbedding({ limit });
  const outcomes: ThreadMessageEmbeddingOutcome[] = [];

  for (const row of pending) {
    try {
      const embedding = await embedder.embedDocumentWithRecovery(modelInfo, row.contentText);
      const stored = await repository.storeEmbedding({
        contentHash: row.contentHash,
        embedding,
        messageId: row.messageId,
      });
      outcomes.push({ messageId: row.messageId, status: stored ? 'embedded' : 'stale' });
    } catch (error) {
      const message = `Thread message "${row.messageId}" embedding failed: ${errorDetail(error)}`;
      const marked = await repository.markEmbeddingError({
        contentHash: row.contentHash,
        error: message,
        messageId: row.messageId,
      });
      if (marked) {
        outcomes.push({ error: message, messageId: row.messageId, status: 'error' });
      } else {
        outcomes.push({ messageId: row.messageId, status: 'stale' });
      }
    }
  }

  return outcomes;
}
