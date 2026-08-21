const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export function isEmbeddingInputHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export async function buildEmbeddingInputHash(
  contentHash: string,
  modelKey: string
): Promise<string> {
  if (contentHash.length === 0) {
    throw new Error('Cannot build an embedding input hash without a content hash.');
  }
  if (modelKey.length === 0) {
    throw new Error('Cannot build an embedding input hash without a model key.');
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Embedding input hashing requires crypto.subtle.digest.');
  }

  const bytes = new TextEncoder().encode(`${contentHash}:${modelKey}`);
  const digest = await subtle.digest('SHA-256', bytes);
  if (digest.byteLength !== 32) {
    throw new Error(`SHA-256 returned an invalid ${digest.byteLength}-byte embedding input hash.`);
  }

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
