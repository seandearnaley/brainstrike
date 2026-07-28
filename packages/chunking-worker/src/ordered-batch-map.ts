export async function mapInOrderedBatches<Input, Output>(
  items: readonly Input[],
  batchSize: number,
  mapper: (item: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('Batch size must be a positive integer');
  }

  const results: Output[] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => mapper(item, offset + batchIndex))
    );
    results.push(...batchResults);
  }
  return results;
}
