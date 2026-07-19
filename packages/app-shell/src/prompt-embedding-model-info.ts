import type { PromptEmbeddingProfile } from '@brainstrike/db';
import {
  type buildLocalEmbeddingModelConfigMap,
  resolveEmbeddingSetModelInfo,
} from '@brainstrike/db-explorer/embedding-models';
import type { EmbeddingSetModelInfo } from '@brainstrike/vector-management';

/**
 * Shared shape of the singleton embedding-profile rows (prompt library 051,
 * thread search 067): each feature's profile is its durable model identity.
 */
export interface SingletonEmbeddingProfileLike {
  readonly dimensions: number;
  readonly modelKey: string;
}

export function resolveSingletonProfileModelInfo(
  profile: SingletonEmbeddingProfileLike,
  localModelConfigMap: ReturnType<typeof buildLocalEmbeddingModelConfigMap>
): EmbeddingSetModelInfo {
  const resolved = resolveEmbeddingSetModelInfo(
    { dimensions: profile.dimensions, modelKey: profile.modelKey },
    localModelConfigMap
  );
  return {
    dimensions: resolved.dimensions,
    modelConfig: resolved.modelConfig ?? null,
    // The profile's composite key is the durable identity checked by the
    // feature's embedding module; resolveEmbeddingSetModelInfo intentionally
    // canonicalizes local keys to the registry id for collection callers.
    modelKey: profile.modelKey,
  };
}

export function resolvePromptEmbeddingModelInfo(
  profile: PromptEmbeddingProfile,
  localModelConfigMap: ReturnType<typeof buildLocalEmbeddingModelConfigMap>
): EmbeddingSetModelInfo {
  return resolveSingletonProfileModelInfo(profile, localModelConfigMap);
}
