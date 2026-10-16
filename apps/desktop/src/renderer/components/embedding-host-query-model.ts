import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import type { ModelConfig } from '@brainstrike/embeddings';
import { assertPinnedPlanResult, pinnedPlanModelConfig } from '@brainstrike/embeddings/pinned-plan';
import {
  decodeCatalogEmbeddingFacts,
  requestedEmbeddingPooling,
} from '@brainstrike/indexing-contract';
import type { EmbeddingHostInferenceRequest } from '../../embedding-host-shared';

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function loadQueryEmbeddingModelConfig(
  catalog: Pick<ModelCatalogCapability, 'read'> | undefined,
  request: EmbeddingHostInferenceRequest
): Promise<ModelConfig> {
  const plan = request.payload.inferencePlan;
  if (plan) {
    return pinnedPlanModelConfig(plan);
  }
  if (!catalog) {
    throw new Error('The embedding host model catalog is unavailable.');
  }
  const { models } = await catalog.read();
  const row = models.find((candidate) => candidate.id === request.payload.modelId);
  if (!row) {
    throw new Error(`Local embedding model ${request.payload.modelId} is not registered.`);
  }

  const capabilities = row.capabilities;
  const parameters = row.parameters ?? {};
  const dimensions = resolveOptionalNumber(capabilities['defaultDimension']);
  if (dimensions !== request.payload.dimensions) {
    throw new Error(
      `Local embedding model ${request.payload.modelId} dimensions do not match embedding set ${request.payload.modelKey}.`
    );
  }

  const { pooling, prompts } = decodeCatalogEmbeddingFacts(capabilities, row.id);
  return {
    description: row.description ?? '',
    dimensions,
    id: row.id,
    name: row.name,
    origin: row.providerId,
    ...(pooling === undefined ? {} : { pooling }),
    ...(prompts === undefined ? {} : { prompts }),
    quantized: false,
    tags: [row.providerId, resolveOptionalString(capabilities['type']) ?? 'embedding'],
    ...(resolveOptionalString(parameters['size'])
      ? { size: resolveOptionalString(parameters['size']) }
      : {}),
    ...(resolveOptionalNumber(parameters['contextWindow'])
      ? { contextWindow: resolveOptionalNumber(parameters['contextWindow']) }
      : {}),
  };
}

export function queryEmbeddingServiceIdentity(request: EmbeddingHostInferenceRequest): string {
  const { modelKey, modelId, dimensions, inferencePlan: plan } = request.payload;
  return JSON.stringify([
    modelKey,
    modelId,
    dimensions,
    plan?.revision ?? null,
    plan?.device ?? null,
    plan?.dtype ?? null,
    plan ? requestedEmbeddingPooling(plan) : null,
    plan?.prompts ? [plan.prompts.query, plan.prompts.document] : null,
  ]);
}

export function assertPinnedQueryEmbeddingResult(
  request: EmbeddingHostInferenceRequest,
  result: import('@brainstrike/embeddings').EmbeddingResult
): void {
  const plan = request.payload.inferencePlan;
  if (plan) {
    assertPinnedPlanResult(plan, result);
  }
}
