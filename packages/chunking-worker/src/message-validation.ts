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
  if (value.length > CHUNKING_CONFIG.maxSeparatorsCount) {
    return false;
  }
  return value.every((separator) => typeof separator === 'string');
}

function isContentString(value: unknown): boolean {
  // Structural validation only enforces "string-ness". Semantic size handling stays in the
  // worker runtime so oversized files become per-file skips/errors instead of terminal
  // "__init__" failures that poison the entire worker session.
  return typeof value === 'string';
}

function isBoundedMetadataString(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CHUNKING_CONFIG.maxMetadataFieldLength
  );
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

function hasValidChunkRequestFields(msg: Record<string, unknown>): boolean {
  return (
    isBoundedMetadataString(msg['id']) &&
    isBoundedMetadataString(msg['fileRecordId']) &&
    isContentString(msg['content']) &&
    isBoundedMetadataString(msg['fileName']) &&
    isBoundedMetadataString(msg['filePath']) &&
    isChunkingRequestOptions(msg['options'])
  );
}

export function isChunkRequest(value: unknown): value is ChunkRequest {
  if (!isChunkRequestRecord(value)) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  return msg['type'] === 'chunk' && hasValidChunkRequestFields(msg);
}

export function isChunkBatchRequest(value: unknown): value is ChunkBatchRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const msg = value as Record<string, unknown>;
  if (
    msg['type'] !== 'chunk-batch' ||
    !Array.isArray(msg['requests']) ||
    msg['requests'].length === 0 ||
    msg['requests'].length > CHUNKING_CONFIG.maxBatchSize
  ) {
    return false;
  }
  for (const req of msg['requests']) {
    if (!isChunkRequestRecord(req)) {
      return false;
    }
    if (!hasValidChunkRequestFields(req as Record<string, unknown>)) {
      return false;
    }
  }
  return true;
}
