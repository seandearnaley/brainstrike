const MODEL_SIZE_PATTERN = /^~?\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB)$/i;

function resolveBinaryUnitBytes(unit: string): number {
  if (unit === 'KB') {
    return 1024;
  }
  if (unit === 'MB') {
    return 1024 ** 2;
  }
  if (unit === 'GB') {
    return 1024 ** 3;
  }
  throw new Error(`Unsupported embedding model size unit: "${unit}".`);
}

export function parseModelSizeEstimateBytes(value: string | undefined): number | null {
  if (value === undefined || value.trim().toLowerCase() === 'unknown') {
    return null;
  }

  const match = MODEL_SIZE_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported embedding model size metadata: "${value}".`);
  }

  const magnitude = Number(match[1]);
  if (!(Number.isFinite(magnitude) && magnitude > 0)) {
    throw new Error('Embedding model size estimate must be positive.');
  }

  const unit = match[2];
  if (!unit) {
    throw new Error(`Embedding model size metadata is missing a unit: "${value}".`);
  }
  const bytes = magnitude * resolveBinaryUnitBytes(unit.toUpperCase());
  if (!(Number.isSafeInteger(bytes) && bytes > 0)) {
    throw new Error(
      `Embedding model size estimate is outside the supported byte range: "${value}".`
    );
  }
  return bytes;
}
