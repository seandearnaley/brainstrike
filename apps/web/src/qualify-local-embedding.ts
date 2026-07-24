interface LocalEmbeddingQualification {
  readonly device: string;
  readonly dimensions: number;
  readonly dtype: string;
  readonly fallbackApplied: boolean;
  readonly finite: boolean;
}

export async function qualifyLocalEmbedding(
  deviceHint: 'wasm' | 'webgpu' = 'wasm'
): Promise<LocalEmbeddingQualification> {
  const dtype = deviceHint === 'webgpu' ? 'fp16' : 'q4';
  const { getEmbeddingQueue } = await import('./create-embedding-queue');
  const queue = getEmbeddingQueue();
  const result = await queue.add({
    deviceHint,
    dtype,
    id: `csp-embedding-${crypto.randomUUID()}`,
    kind: 'embed',
    maxBatchSize: 1,
    model: 'Xenova/all-MiniLM-L6-v2',
    targetDimension: 384,
    texts: ['Brainstrike production CSP qualification'],
    truncateDim: 384,
  });
  const vector = result.vectors[0];
  const dimensions = result.metadata.dimensions ?? vector?.length ?? 0;
  const finite =
    vector !== undefined &&
    vector.length === 384 &&
    Array.from(vector).every((value) => Number.isFinite(value));
  if (
    result.metadata.device !== deviceHint ||
    result.metadata.dtype !== dtype ||
    result.metadata.fallbackApplied !== false ||
    dimensions !== 384 ||
    !finite
  ) {
    throw new Error('Web E2E local embedding qualification failed');
  }
  return {
    device: result.metadata.device,
    dimensions,
    dtype: result.metadata.dtype,
    fallbackApplied: result.metadata.fallbackApplied,
    finite,
  };
}
