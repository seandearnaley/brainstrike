import type { DatabaseWorkOptions } from '@brainstrike/db';
import { checkApiKeyAvailability } from '@brainstrike/embeddings';
import { canonicalizeEmbeddingProviderModelKey } from '@brainstrike/indexing-contract';
import type {
  ApiKeyValidation,
  VectorQueueDatabase,
  VectorQueueService,
  VectorQueueSnapshotReader,
} from './vector-queue-service';

type TursoVectorQueueActionOperation =
  | 'clearEmbeddingsForSet'
  | 'clearQueue'
  | 'retryFailed'
  | 'wipeQueue';

type TursoVectorQueueActionBridge = (
  operation: TursoVectorQueueActionOperation,
  payload: unknown,
  options?: DatabaseWorkOptions
) => Promise<unknown>;

interface DesktopTursoVectorQueueServiceDependencies {
  readonly db: VectorQueueDatabase;
  readonly snapshotReader: VectorQueueSnapshotReader;
}

function getDesktopTursoVectorQueueActionBridge(): TursoVectorQueueActionBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const dbBridge = (
    window as Window & {
      electronAPI?: {
        db?: {
          tursoVectorQueueAction?: unknown;
        };
      };
    }
  ).electronAPI?.db;
  return typeof dbBridge?.tursoVectorQueueAction === 'function'
    ? (dbBridge.tursoVectorQueueAction as TursoVectorQueueActionBridge)
    : null;
}

function actionWorkOptions(operation: TursoVectorQueueActionOperation): DatabaseWorkOptions {
  return {
    label: `turso.vector-queue.action.${operation}`,
    priority: 'normal',
  };
}

function parseClearEmbeddingsForSetResult(result: unknown): number {
  const cleared =
    result && typeof result === 'object' && 'cleared' in result
      ? (result as { cleared: unknown }).cleared
      : undefined;
  if (!(typeof cleared === 'number' && Number.isInteger(cleared) && cleared >= 0)) {
    throw new Error('Desktop Turso clearEmbeddingsForSet returned an invalid cleared count.');
  }
  return cleared;
}

async function resolveEmbeddingSetModelKey(
  db: VectorQueueDatabase,
  embeddingSetId: string
): Promise<string> {
  const result = await db.query<{
    modelKey: string | null;
  }>(
    `SELECT model_key AS "modelKey"
       FROM embedding_sets
      WHERE id = ?
      LIMIT 1`,
    [embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Embedding set ${embeddingSetId} not found`);
  }
  const rawKey = row.modelKey?.trim();
  if (!rawKey) {
    throw new Error(`Embedding set ${embeddingSetId} is missing model_key metadata`);
  }
  const canonical = canonicalizeEmbeddingProviderModelKey(rawKey);
  if (!canonical) {
    throw new Error(`Embedding set ${embeddingSetId} has invalid model_key metadata`);
  }
  return canonical.composite;
}

export function createDesktopTursoVectorQueueService(
  dependencies: DesktopTursoVectorQueueServiceDependencies
): VectorQueueService | null {
  const bridge = getDesktopTursoVectorQueueActionBridge();
  if (!bridge) {
    return null;
  }
  const { db, snapshotReader } = dependencies;
  return {
    refresh: (activeSetId) => snapshotReader.refresh(activeSetId),

    async validateApiKeyForSet(embeddingSetId): Promise<ApiKeyValidation> {
      try {
        const modelKey = await resolveEmbeddingSetModelKey(db, embeddingSetId);
        const validation = await checkApiKeyAvailability(modelKey);
        if (validation.available) {
          return { valid: true };
        }
        return { valid: false, reason: validation.reason, message: validation.message };
      } catch (error) {
        return {
          valid: false,
          reason: 'validation-error',
          message: error instanceof Error ? error.message : 'Failed to validate API key',
        };
      }
    },

    async retryFailed(limit) {
      await bridge('retryFailed', { limit }, actionWorkOptions('retryFailed'));
    },

    async clearQueue(states) {
      await bridge(
        'clearQueue',
        states ? { states: [...states] } : {},
        actionWorkOptions('clearQueue')
      );
    },

    async clearEmbeddingsForSet(embeddingSetId) {
      const result = await bridge(
        'clearEmbeddingsForSet',
        { embeddingSetId },
        actionWorkOptions('clearEmbeddingsForSet')
      );
      return parseClearEmbeddingsForSetResult(result);
    },

    async wipeQueue() {
      await bridge('wipeQueue', null, actionWorkOptions('wipeQueue'));
    },

    async backfill() {
      throw new Error(
        'Desktop Turso backfill must be enqueued through the embedding runtime controller.'
      );
    },

    async reembedSet() {
      throw new Error(
        'Desktop Turso re-embed must be coordinated through the embedding runtime controller.'
      );
    },
  };
}
