import { isChunkingStrategy } from '@brainstrike/text-splitter';
import { CHUNKING_CONFIG } from './chunking-config';
import type { ChunkBatchRequest, ChunkingRequestOptions, ChunkRequest } from './shared';

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function isOptionalBoundedPositiveInteger(value: unknown, max: number): boolean {
  return isOptionalPositiveInteger(value) && (value === undefined || (value as number) <= max);
}

function isOptionalBoundedNonNegativeInteger(value: unknown, max: number): boolean {
  return isOptionalNonNegativeInteger(value) && (value === undefined || (value as number) <= max);
}

function isOptionalStringArray(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((separator) => typeof separator === 'string');
}

function isContentString(value: unknown): boolean {
  return typeof value === 'string' && value.length <= CHUNKING_CONFIG.maxChunkableSize;
}

function isChunkRequestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
  return (
    isChunkingStrategy(obj['strategy']) &&
    isOptionalBoolean(obj['allowLargeFiles']) &&
    isOptionalBoolean(obj['forceStrategy']) &&
    isOptionalBoolean(obj['ignoreFileTypeRecommendations']) &&
    isOptionalBoolean(obj['tokenTrueSizing']) &&
    isOptionalBoundedPositiveInteger(obj['maxTokens'], CHUNKING_CONFIG.maxTokensHardLimit) &&
    isOptionalBoundedPositiveInteger(obj['maxTokensCap'], CHUNKING_CONFIG.maxTokensHardLimit) &&
    isOptionalBoundedNonNegativeInteger(obj['overlap'], CHUNKING_CONFIG.overlapHardLimit) &&
    isOptionalStringArray(obj['separators'])
  );
}

export function isChunkRequest(value: unknown): value is ChunkRequest {
  if (!isChunkRequestRecord(value)) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return (
    msg['type'] === 'chunk' &&
    typeof msg['id'] === 'string' &&
    typeof msg['fileRecordId'] === 'string' &&
    isContentString(msg['content']) &&
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
  if (
    msg['type'] !== 'chunk-batch' ||
    !Array.isArray(msg['requests']) ||
    msg['requests'].length > CHUNKING_CONFIG.maxChunkableSize
  ) {
    return false;
  }
  for (const req of msg['requests']) {
    if (!isChunkRequestRecord(req)) {
      return false;
    }
    const request = req as Record<string, unknown>;
    if (
      typeof request['id'] !== 'string' ||
      typeof request['fileRecordId'] !== 'string' ||
      !isContentString(request['content']) ||
      typeof request['fileName'] !== 'string' ||
      typeof request['filePath'] !== 'string' ||
      !isChunkingRequestOptions(request['options'])
    ) {
      return false;
    }
  }
  return true;
}
