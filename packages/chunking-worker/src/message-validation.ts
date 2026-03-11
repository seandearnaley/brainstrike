import { isChunkingStrategy } from '@brainstrike/text-splitter';
import type { ChunkBatchRequest, ChunkingRequestOptions, ChunkRequest } from './shared';

/**
 * Worker message validation must stay aligned with the canonical chunking strategy
 * contract. If the supported strategy set changes, update the shared source of
 * truth in @brainstrike/text-splitter instead of widening this validator locally.
 */
export function isChunkingRequestOptions(value: unknown): value is ChunkingRequestOptions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return isChunkingStrategy(obj['strategy']);
}

export function isChunkRequest(value: unknown): value is ChunkRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return (
    msg['type'] === 'chunk' &&
    typeof msg['id'] === 'string' &&
    typeof msg['fileRecordId'] === 'string' &&
    typeof msg['content'] === 'string' &&
    typeof msg['fileName'] === 'string' &&
    typeof msg['filePath'] === 'string' &&
    isChunkingRequestOptions(msg['options'])
  );
}

export function isChunkBatchRequest(value: unknown): value is ChunkBatchRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  if (msg['type'] !== 'chunk-batch' || !Array.isArray(msg['requests'])) {
    return false;
  }
  for (const req of msg['requests']) {
    if (typeof req !== 'object' || req === null) {
      return false;
    }
    const request = req as Record<string, unknown>;
    if (
      typeof request['id'] !== 'string' ||
      typeof request['fileRecordId'] !== 'string' ||
      typeof request['content'] !== 'string' ||
      typeof request['fileName'] !== 'string' ||
      typeof request['filePath'] !== 'string' ||
      !isChunkingRequestOptions(request['options'])
    ) {
      return false;
    }
  }
  return true;
}
