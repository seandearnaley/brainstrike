import { createPriorityDbHandle } from '@brainstrike/db';
import type { usePGliteDatabase } from '@brainstrike/db/react';
import type { ModelConfig } from '@brainstrike/embeddings';
import type { EmbeddingHostQueryEmbeddingRequest } from '../../embedding-host-shared';

interface DbModelRow {
  readonly capabilities: unknown;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly parameters: unknown;
  readonly providerId: string;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function loadQueryEmbeddingModelConfig(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>,
  request: EmbeddingHostQueryEmbeddingRequest
): Promise<ModelConfig> {
  // A user's search waits on this read. Host-window work defaults to background,
  // which the desktop scheduler rejects while database integrity is contained
  // (BST-1870), so the read runs on the foreground lane.
  const result = await createPriorityDbHandle(db, 'foreground').query<DbModelRow>(
    `SELECT
      id,
      provider_id AS "providerId",
      name,
      description,
      capabilities,
      parameters
     FROM models
     WHERE id = $1
     LIMIT 1`,
    [request.payload.modelId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Local embedding model ${request.payload.modelId} is not registered.`);
  }

  const capabilities = parseRecord(row.capabilities);
  const parameters = parseRecord(row.parameters);
  const dimensions = resolveOptionalNumber(capabilities['defaultDimension']);
  if (dimensions !== request.payload.dimensions) {
    throw new Error(
      `Local embedding model ${request.payload.modelId} dimensions do not match embedding set ${request.payload.modelKey}.`
    );
  }

  return {
    description: row.description ?? '',
    dimensions,
    id: row.id,
    name: row.name,
    origin: row.providerId,
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
