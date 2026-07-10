import type { PromptEmbeddingProfile } from '@brainstrike/db';
import {
  type buildLocalEmbeddingModelConfigMap,
  resolveEmbeddingSetModelInfo,
} from '@brainstrike/db-explorer/embedding-models';
import type { EmbeddingSetModelInfo } from '@brainstrike/vector-management';

export function resolvePromptEmbeddingModelInfo(
  profile: PromptEmbeddingProfile,
  localModelConfigMap: ReturnType<typeof buildLocalEmbeddingModelConfigMap>
): EmbeddingSetModelInfo {
  const resolved = resolveEmbeddingSetModelInfo(
    { dimensions: profile.dimensions, modelKey: profile.modelKey },
    localModelConfigMap
  );
  return {
    dimensions: resolved.dimensions,
    modelConfig: resolved.modelConfig ?? null,
    // The prompt profile's composite key is the durable identity checked by
    // prompt-library-embedding; resolveEmbeddingSetModelInfo intentionally
    // canonicalizes local keys to the registry id for collection callers.
    modelKey: profile.modelKey,
  };
}
