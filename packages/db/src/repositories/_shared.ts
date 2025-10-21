/**
 * Shared utilities for database repositories
 */

export interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const embeddingDimensionCache = new Map<string, number>();

async function resolveEmbeddingSetDimension(
  db: Queryable,
  embeddingSetId: string
): Promise<number> {
  const cached = embeddingDimensionCache.get(embeddingSetId);
  if (typeof cached === 'number') {
    return cached;
  }

  const result = await db.query<{ dimensions?: number }>(
    'SELECT dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
    [embeddingSetId]
  );
  const dimensionsRaw = result.rows[0]?.dimensions;
  const dimensions = typeof dimensionsRaw === 'number' ? dimensionsRaw : Number(dimensionsRaw ?? 0);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding set ${embeddingSetId} is missing or has invalid dimensions (${dimensionsRaw}).`
    );
  }

  embeddingDimensionCache.set(embeddingSetId, dimensions);
  return dimensions;
}

/**
 * Validate embedding payloads against optional target dimensions.
 * Ensures embeddings are numeric arrays and match the provided embedding_set dimensions.
 */
export async function validateEmbeddingDimension(
  db: Queryable,
  embedding: number[] | undefined,
  options: { embeddingSetId?: string | null; expectedDimension?: number } = {}
): Promise<void> {
  if (!embedding) return;

  if (!Array.isArray(embedding)) {
    throw new Error(
      `Invalid embedding: expected number array, received ${typeof embedding} instead.`
    );
  }

  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('Embeddings must contain only finite numeric values.');
    }
  }

  let targetDimension = options.expectedDimension;
  if (options.embeddingSetId) {
    targetDimension = await resolveEmbeddingSetDimension(db, options.embeddingSetId);
  }

  if (typeof targetDimension === 'number') {
    if (!Number.isInteger(targetDimension) || targetDimension <= 0) {
      throw new Error(
        `Invalid target embedding dimension (${targetDimension}). Expected a positive integer.`
      );
    }
    if (embedding.length !== targetDimension) {
      throw new Error(
        `Embedding dimension mismatch: received ${embedding.length}, expected ${targetDimension}.`
      );
    }
  }
}

/**
 * Parse embeddings from various formats (TEXT/pgvector/JSON)
 * Handles multiple input formats:
 * - JSON array string: "[0.1, 0.2, 0.3]"
 * - pgvector text format: "[0.1,0.2,0.3]" (no spaces)
 * - pgvector parentheses format: "(0.1,0.2,0.3)"
 * - Comma-separated string: "0.1,0.2,0.3"
 * - Native array: [0.1, 0.2, 0.3]
 *
 * @param embedding - The embedding data in various formats
 * @returns Parsed number array or undefined if parsing fails
 */
// Helper to validate array of numbers
function validateNumberArray(arr: unknown[]): arr is number[] {
  return arr.every((item) => typeof item === 'number');
}

// Helper to parse string to number array
function parseStringToNumbers(str: string): number[] {
  const parts = str.split(',').map((part) => part.trim());
  return parts.map((part) => {
    const num = Number.parseFloat(part);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number: ${part}`);
    }
    return num;
  });
}

// Helper to handle array inputs
function handleArrayInput(arr: unknown[]): number[] | undefined {
  if (validateNumberArray(arr)) {
    return arr;
  }
  console.warn('parseEmbeddingLoose: Array contains non-numeric values');
  return undefined;
}

// Helper to handle string inputs
function handleStringInput(str: string): number[] | undefined {
  let cleanedString = str.trim();

  // Remove outer brackets or parentheses
  if (cleanedString.startsWith('(') && cleanedString.endsWith(')')) {
    cleanedString = cleanedString.slice(1, -1);
    return parseStringToNumbers(cleanedString);
  }

  if (cleanedString.startsWith('[') && cleanedString.endsWith(']')) {
    // Try JSON.parse for proper JSON arrays
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed) && validateNumberArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid JSON, remove brackets and continue
    }
    cleanedString = cleanedString.slice(1, -1);
  }

  return parseStringToNumbers(cleanedString);
}

export function parseEmbeddingLoose(embedding: unknown): number[] | undefined {
  if (!embedding) return undefined;

  try {
    if (Array.isArray(embedding)) {
      return handleArrayInput(embedding);
    }

    if (typeof embedding === 'string') {
      return handleStringInput(embedding);
    }

    console.warn('parseEmbeddingLoose: Unsupported embedding type:', typeof embedding);
    return undefined;
  } catch (error) {
    console.warn(
      'parseEmbeddingLoose: Failed to parse embedding:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return undefined;
  }
}

/**
 * Batch an array into chunks of specified size
 * @param items - Array to batch
 * @param batchSize - Size of each batch
 * @returns Array of batches
 */
export function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Compute cosine similarity between two vectors
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity between -1 and 1, or NaN if computation fails
 */
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return Number.NaN;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (
      aVal === undefined ||
      bVal === undefined ||
      !Number.isFinite(aVal) ||
      !Number.isFinite(bVal)
    ) {
      return Number.NaN;
    }
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  if (normA === 0 || normB === 0) {
    return Number.NaN;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

  // Clamp to [-1, 1] range to handle floating-point precision issues
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Convert cosine similarity to a search-friendly similarity score in [0, 1] range
 * @param cosineSimilarity - Raw cosine similarity value [-1, 1]
 * @returns Similarity score in [0, 1] range, where 1 is most similar
 */
export function cosineToSearchSimilarity(cosineSimilarity: number): number {
  if (!Number.isFinite(cosineSimilarity)) {
    return 0;
  }
  // Convert [-1, 1] to [0, 1] where 1 means identical and 0 means opposite
  return (cosineSimilarity + 1) / 2;
}

export interface UpdateBuilder {
  setParts: string[];
  values: unknown[];
  index: number;
}

export function createUpdateBuilder(startIndex = 1): UpdateBuilder {
  return { setParts: [], values: [], index: startIndex };
}

export function appendColumn(builder: UpdateBuilder, column: string, value: unknown): void {
  builder.setParts.push(`${column} = $${builder.index}`);
  builder.values.push(value);
  builder.index += 1;
}

export function appendColumnIfDefined<T>(
  builder: UpdateBuilder,
  column: string,
  value: T | undefined
): void {
  if (value !== undefined) {
    appendColumn(builder, column, value);
  }
}

export function appendRawClause(builder: UpdateBuilder, clause: string, value: unknown): void {
  builder.setParts.push(`${clause} = $${builder.index}`);
  builder.values.push(value);
  builder.index += 1;
}
