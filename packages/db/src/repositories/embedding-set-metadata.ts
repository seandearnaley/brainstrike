import { formatProviderModelKey, parseProviderModelKey } from '@brainstrike/utils';

interface ModelRegistryRow {
  id: string;
  name: string;
  providerId: string;
}

interface QueryableDb {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

export interface PersistedEmbeddingSetMetadata {
  id: string;
  modelId: string;
  modelKey: string;
}

export interface ResolvedEmbeddingSetMetadata {
  modelId: string;
  modelKey: string;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  );
}

function buildPlaceholderList(values: readonly string[], startIndex = 1): string {
  return values.map((_, index) => `$${startIndex + index}`).join(', ');
}

function isMissingModelsTableError(error: unknown): boolean {
  if (!(typeof error === 'object' && error !== null && 'code' in error)) {
    return false;
  }
  return error.code === '42P01';
}

async function findRegistryCandidatesById(
  db: QueryableDb,
  values: readonly string[]
): Promise<ModelRegistryRow[]> {
  if (!values.length) {
    return [];
  }
  const placeholderList = buildPlaceholderList(values);
  try {
    const result = await db.query<ModelRegistryRow>(
      `SELECT id,
              provider_id AS "providerId",
              name
         FROM models
        WHERE id IN (${placeholderList})`,
      [...values]
    );
    return result.rows;
  } catch (error) {
    if (isMissingModelsTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function findRegistryCandidatesByName(
  db: QueryableDb,
  values: readonly string[]
): Promise<ModelRegistryRow[]> {
  if (!values.length) {
    return [];
  }
  const placeholderList = buildPlaceholderList(values);
  try {
    const result = await db.query<ModelRegistryRow>(
      `SELECT id,
              provider_id AS "providerId",
              name
         FROM models
        WHERE LOWER(name) IN (${placeholderList})`,
      values.map((value) => value.toLowerCase())
    );
    return result.rows;
  } catch (error) {
    if (isMissingModelsTableError(error)) {
      return [];
    }
    throw error;
  }
}

function toResolvedRegistryMetadata(row: ModelRegistryRow): ResolvedEmbeddingSetMetadata {
  return {
    modelId: row.id,
    modelKey: formatProviderModelKey(row.providerId, row.id),
  };
}

export async function tryResolveEmbeddingSetMetadata(
  db: QueryableDb,
  input: {
    modelId: string;
    modelKey: string;
  }
): Promise<ResolvedEmbeddingSetMetadata | null> {
  const parsed = parseProviderModelKey(input.modelKey);
  if (parsed) {
    return {
      modelId: parsed.modelId,
      modelKey: formatProviderModelKey(parsed.provider, parsed.modelId),
    };
  }

  const exactCandidates = await findRegistryCandidatesById(
    db,
    uniqueNonEmpty([input.modelKey, input.modelId])
  );
  const exactCandidate = exactCandidates[0];
  if (exactCandidates.length === 1 && exactCandidate) {
    return toResolvedRegistryMetadata(exactCandidate);
  }
  if (exactCandidates.length > 1) {
    return null;
  }

  const nameCandidates = await findRegistryCandidatesByName(
    db,
    uniqueNonEmpty([input.modelKey, input.modelId])
  );
  const nameCandidate = nameCandidates[0];
  if (nameCandidates.length === 1 && nameCandidate) {
    return toResolvedRegistryMetadata(nameCandidate);
  }

  return null;
}

export async function normalizeEmbeddingSetInputMetadata(
  db: QueryableDb,
  input: {
    modelId: string;
    modelKey: string;
  }
): Promise<ResolvedEmbeddingSetMetadata> {
  const resolved = await tryResolveEmbeddingSetMetadata(db, input);
  if (resolved) {
    return resolved;
  }

  const modelKey = input.modelKey.trim();
  const modelId = input.modelId.trim();
  if (!(modelKey && modelId)) {
    throw new Error('Embedding set metadata is invalid. modelKey and modelId are required.');
  }
  return {
    modelId,
    modelKey,
  };
}

export async function repairPersistedEmbeddingSetMetadata(
  db: QueryableDb,
  metadata: PersistedEmbeddingSetMetadata
): Promise<ResolvedEmbeddingSetMetadata | null> {
  const resolved = await tryResolveEmbeddingSetMetadata(db, metadata);
  if (!resolved) {
    return null;
  }

  if (resolved.modelKey === metadata.modelKey && resolved.modelId === metadata.modelId) {
    return resolved;
  }

  await db.query(
    `UPDATE embedding_sets
        SET model_key = $1,
            model_id = $2
      WHERE id = $3`,
    [resolved.modelKey, resolved.modelId, metadata.id]
  );

  return resolved;
}
