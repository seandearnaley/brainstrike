import type { Job } from '@brainstrike/db';
import type { ProviderDimensionParameter } from '@brainstrike/queue';
import type { EmbeddingProviderType } from '../provider-types';
import { formatProviderModelKey, isHostedProvider, parseProviderModelKey } from '../provider-utils';

export interface EmbedChunkPayload {
  chunkId: string;
  dimensionParameter?: ProviderDimensionParameter | null;
  embeddingSetId?: string | null;
  expectedDimension?: number;
  fileRecordId?: string;
  modelKey?: string | null;
  provider?: EmbeddingProviderType | null;
}

export interface EmbeddingJobModel {
  compositeKey: string;
  modelId: string;
  provider: EmbeddingProviderType;
}

export function assertEmbedChunkJob(claimed: Job): EmbedChunkPayload {
  if (claimed.jobType !== 'embed_chunk') {
    throw new Error(`Unsupported job type: ${claimed.jobType}`);
  }
  const payload = (claimed.payload || {}) as EmbedChunkPayload;
  if (typeof payload.chunkId !== 'string' || payload.chunkId.length === 0) {
    throw new Error('Missing chunkId in payload');
  }
  if (typeof payload.embeddingSetId !== 'string' || payload.embeddingSetId.length === 0) {
    throw new Error('Missing embeddingSetId in payload');
  }
  if (typeof payload.modelKey !== 'string' || payload.modelKey.length === 0) {
    throw new Error('Missing modelKey in payload');
  }
  if (!Number.isFinite(payload.expectedDimension) || (payload.expectedDimension ?? 0) <= 0) {
    throw new Error('Missing expectedDimension in payload');
  }
  return payload;
}

export function resolveTargetSetId(payload: EmbedChunkPayload): string {
  return payload.embeddingSetId ?? '';
}

export function resolveJobModel(payload: EmbedChunkPayload): EmbeddingJobModel {
  const rawModelKey = payload.modelKey ?? '';
  const providerHint = payload.provider ?? undefined;

  const candidateComposite = (() => {
    const parsed = parseProviderModelKey(rawModelKey);
    if (parsed) {
      return rawModelKey;
    }
    if (providerHint && isHostedProvider(providerHint)) {
      return formatProviderModelKey(providerHint, rawModelKey);
    }
    throw new Error(`Invalid modelKey in payload: ${rawModelKey}`);
  })();

  const compositeKey = candidateComposite;
  const parsed = parseProviderModelKey(compositeKey);

  if (parsed) {
    return {
      compositeKey,
      provider: parsed.provider,
      modelId: parsed.modelId,
    };
  }

  return {
    compositeKey,
    provider: 'local',
    modelId: compositeKey,
  };
}
