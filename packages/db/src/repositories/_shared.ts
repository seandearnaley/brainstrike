/**
 * Shared utilities for database repositories
 */

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
