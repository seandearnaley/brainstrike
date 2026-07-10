import {
  buildPromptItemEmbeddingText,
  type PromptEmbeddingProfile,
  type PromptItemRepository,
  type PromptItemSimilarityOptions,
  type PromptItemSimilarityResult,
} from '@brainstrike/db';
import type {
  EmbeddingSetModelInfo,
  UseSearchEmbedderResult,
} from '@brainstrike/vector-management';

export type PromptLibraryEmbeddingRepository = Pick<
  PromptItemRepository,
  | 'getEmbeddingProfile'
  | 'listNeedingEmbedding'
  | 'markEmbeddingError'
  | 'searchSimilar'
  | 'storeEmbedding'
>;

export type PromptLibraryEmbedder = Pick<
  UseSearchEmbedderResult,
  'embedDocumentWithRecovery' | 'embedQueryWithRecovery'
>;

export type PromptItemEmbeddingOutcome =
  | {
      readonly itemId: string;
      readonly revision: number;
      readonly status: 'embedded' | 'stale';
    }
  | {
      readonly error: string;
      readonly itemId: string;
      readonly revision: number;
      readonly status: 'error';
    };

interface PromptEmbeddingDependencies {
  readonly embedder: PromptLibraryEmbedder;
  readonly modelInfo: EmbeddingSetModelInfo;
  readonly repository: PromptLibraryEmbeddingRepository;
}

export interface QueryPromptSuggestionsInput extends PromptEmbeddingDependencies {
  readonly context: string;
  readonly options?: PromptItemSimilarityOptions;
}

function assertModelMatchesProfile(
  profile: PromptEmbeddingProfile,
  modelInfo: EmbeddingSetModelInfo
): void {
  if (profile.modelKey === modelInfo.modelKey && profile.dimensions === modelInfo.dimensions) {
    if (!modelInfo.modelConfig || modelInfo.modelConfig.id === profile.modelId) {
      return;
    }
    throw new Error(
      `Prompt embedding model config does not match profile "${profile.id}": expected ${profile.modelId}, received ${modelInfo.modelConfig.id}.`
    );
  }

  throw new Error(
    `Prompt embedding model does not match profile "${profile.id}": expected ${profile.modelKey} (${profile.dimensions} dimensions), received ${modelInfo.modelKey} (${modelInfo.dimensions} dimensions).`
  );
}

async function requireMatchingProfile(
  repository: PromptLibraryEmbeddingRepository,
  modelInfo: EmbeddingSetModelInfo
): Promise<void> {
  const profile = await repository.getEmbeddingProfile();
  assertModelMatchesProfile(profile, modelInfo);
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
 * Embeds every currently pending prompt item one at a time. Sequential execution
 * avoids contending for the same local embedding runtime, while revision-CAS
 * writes prevent a late result from overwriting a newer edit.
 */
export async function embedPendingPromptItems({
  embedder,
  modelInfo,
  repository,
}: PromptEmbeddingDependencies): Promise<PromptItemEmbeddingOutcome[]> {
  await requireMatchingProfile(repository, modelInfo);
  const pendingItems = await repository.listNeedingEmbedding();
  const outcomes: PromptItemEmbeddingOutcome[] = [];

  for (const item of pendingItems) {
    try {
      const embedding = await embedder.embedDocumentWithRecovery(
        modelInfo,
        buildPromptItemEmbeddingText(item)
      );
      const stored = await repository.storeEmbedding({
        embedding,
        itemId: item.id,
        revision: item.revision,
      });
      outcomes.push({
        itemId: item.id,
        revision: item.revision,
        status: stored ? 'embedded' : 'stale',
      });
    } catch (error) {
      const message = `Prompt item "${item.id}" embedding failed: ${errorDetail(error)}`;
      const marked = await repository.markEmbeddingError(item.id, item.revision, message);
      if (!marked) {
        outcomes.push({ itemId: item.id, revision: item.revision, status: 'stale' });
        continue;
      }
      outcomes.push({ error: message, itemId: item.id, revision: item.revision, status: 'error' });
    }
  }

  return outcomes;
}

/**
 * Finds semantically related library items using query embeddings. Errors are
 * intentionally allowed to propagate; callers must surface vector-recall
 * unavailability instead of substituting a lexical result.
 */
export async function queryPromptSuggestions({
  context,
  embedder,
  modelInfo,
  options,
  repository,
}: QueryPromptSuggestionsInput): Promise<PromptItemSimilarityResult[]> {
  if (!context.trim()) {
    throw new Error('Prompt suggestion context must contain non-whitespace text.');
  }

  await requireMatchingProfile(repository, modelInfo);
  const queryEmbedding = await embedder.embedQueryWithRecovery(modelInfo, context);
  return repository.searchSimilar(queryEmbedding, options);
}
