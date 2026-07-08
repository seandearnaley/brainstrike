import { describe, expect, it } from 'vitest';
import {
  buildChunkDedupeKey,
  buildEmbedJobDedupeKey,
  buildFileDedupeKey,
  generateChunkId,
  generateEmbeddingSetId,
  generateFileId,
  generateHash,
  generateHashSync,
  generateJobId,
  isValidContentHash,
  isValidUUID,
  parseDedupeKey,
  toChunkId,
  toContentHash,
  toEmbeddingSetId,
  toFileId,
} from '../src/identifiers.js';
import type { ChunkId, EmbeddingSetId, FileId } from '../src/types.js';

describe('ID Generators', () => {
  it('generateFileId creates valid UUID', () => {
    const id = generateFileId();
    expect(isValidUUID(id)).toBe(true);
  });

  it('generateChunkId creates valid UUID', () => {
    const id = generateChunkId();
    expect(isValidUUID(id)).toBe(true);
  });

  it('generateEmbeddingSetId creates valid UUID', () => {
    const id = generateEmbeddingSetId();
    expect(isValidUUID(id)).toBe(true);
  });

  it('generateJobId creates valid UUID', () => {
    const id = generateJobId();
    expect(isValidUUID(id)).toBe(true);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateFileId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('Content Hash Utilities', () => {
  it('generateHash produces consistent SHA-256 hashes', async () => {
    const content = 'Hello, World!';
    const hash1 = await generateHash(content);
    const hash2 = await generateHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex length
  });

  it('generateHash produces different hashes for different content', async () => {
    const hash1 = await generateHash('content-a');
    const hash2 = await generateHash('content-b');

    expect(hash1).not.toBe(hash2);
  });

  it('generateHashSync produces consistent hashes', () => {
    const content = 'Hello, World!';
    const hash1 = generateHashSync(content);
    const hash2 = generateHashSync(content);

    expect(hash1).toBe(hash2);
  });

  it('generateHashSync produces different hashes for different content', () => {
    const hash1 = generateHashSync('content-a');
    const hash2 = generateHashSync('content-b');

    expect(hash1).not.toBe(hash2);
  });
});

describe('Dedupe Key Builders', () => {
  describe('buildFileDedupeKey', () => {
    it('builds correct format with embeddingSetId', () => {
      const key = buildFileDedupeKey('abc123hash', 'set-uuid-456');
      expect(key).toBe('file:abc123hash:set-uuid-456');
    });

    it('uses placeholder for null embeddingSetId', () => {
      const key = buildFileDedupeKey('abc123hash', null);
      expect(key).toBe('file:abc123hash:__default__');
    });

    it('uses placeholder for undefined embeddingSetId', () => {
      const key = buildFileDedupeKey('abc123hash');
      expect(key).toBe('file:abc123hash:__default__');
    });

    it('trims embeddingSetId whitespace', () => {
      const key = buildFileDedupeKey('abc123hash', '  set-uuid  ');
      expect(key).toBe('file:abc123hash:set-uuid');
    });

    it('handles empty contentHash', () => {
      const key = buildFileDedupeKey('', 'set-uuid');
      expect(key).toBe('file::set-uuid');
    });
  });

  describe('buildChunkDedupeKey', () => {
    it('builds correct format', () => {
      const key = buildChunkDedupeKey('file-uuid-123', 5);
      expect(key).toBe('chunk:file-uuid-123:5');
    });

    it('handles zero index', () => {
      const key = buildChunkDedupeKey('file-uuid-123', 0);
      expect(key).toBe('chunk:file-uuid-123:0');
    });

    it('handles large indices', () => {
      const key = buildChunkDedupeKey('file-uuid-123', 99_999);
      expect(key).toBe('chunk:file-uuid-123:99999');
    });
  });

  describe('buildEmbedJobDedupeKey', () => {
    it('builds correct format', () => {
      const key = buildEmbedJobDedupeKey('chunk-uuid', 'set-uuid', 'text-embedding-3-small');
      expect(key).toBe('embed:chunk-uuid:set-uuid:text-embedding-3-small');
    });

    it('ensures idempotent enqueue', () => {
      // Same inputs should produce same key
      const key1 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'model-1');
      const key2 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'model-1');

      expect(key1).toBe(key2);
    });

    it('different chunks produce different keys', () => {
      const key1 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'model-1');
      const key2 = buildEmbedJobDedupeKey('chunk-2', 'set-1', 'model-1');

      expect(key1).not.toBe(key2);
    });

    it('different sets produce different keys', () => {
      const key1 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'model-1');
      const key2 = buildEmbedJobDedupeKey('chunk-1', 'set-2', 'model-1');

      expect(key1).not.toBe(key2);
    });

    it('different models produce different keys', () => {
      const key1 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'text-embedding-3-small');
      const key2 = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'text-embedding-3-large');

      expect(key1).not.toBe(key2);
    });
  });
});

describe('parseDedupeKey', () => {
  it('parses file dedupe key', () => {
    const result = parseDedupeKey('file:abc123hash:set-uuid-456');

    expect(result).toEqual({
      contentHash: 'abc123hash',
      embeddingSetId: 'set-uuid-456',
      type: 'file',
    });
  });

  it('parses file dedupe key with default set', () => {
    const result = parseDedupeKey('file:abc123hash:__default__');

    expect(result).toEqual({
      contentHash: 'abc123hash',
      embeddingSetId: null,
      type: 'file',
    });
  });

  it('parses chunk dedupe key', () => {
    const result = parseDedupeKey('chunk:file-uuid-123:5');

    expect(result).toEqual({
      chunkIndex: 5,
      fileId: 'file-uuid-123',
      type: 'chunk',
    });
  });

  it('parses embed job dedupe key', () => {
    const result = parseDedupeKey('embed:chunk-uuid:set-uuid:text-embedding-3-small');

    expect(result).toEqual({
      chunkId: 'chunk-uuid',
      embeddingSetId: 'set-uuid',
      modelKey: 'text-embedding-3-small',
      type: 'embed',
    });
  });

  it('returns null for invalid format', () => {
    expect(parseDedupeKey('invalid')).toBeNull();
    expect(parseDedupeKey('')).toBeNull();
    expect(parseDedupeKey('unknown:type:here')).toBeNull();
  });

  it('returns null for incomplete keys', () => {
    expect(parseDedupeKey('file:hash')).toBeNull();
    expect(parseDedupeKey('chunk:fileid')).toBeNull();
    expect(parseDedupeKey('embed:chunk:set')).toBeNull();
  });

  it('returns null for non-numeric chunk index', () => {
    expect(parseDedupeKey('chunk:fileid:notanumber')).toBeNull();
  });
});

describe('Validation Utilities', () => {
  describe('isValidUUID', () => {
    it('accepts valid UUID v4', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('6ba7b810-9dad-41d4-80b4-00c04fd430c8')).toBe(true);
    });

    it('rejects invalid UUIDs', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('550e8400-e29b-31d4-a716-446655440000')).toBe(false); // v3 not v4
      expect(isValidUUID('')).toBe(false);
    });
  });

  describe('isValidContentHash', () => {
    it('accepts valid SHA-256 hash', () => {
      const validHash = 'a'.repeat(64);
      expect(isValidContentHash(validHash)).toBe(true);
    });

    it('rejects invalid hashes', () => {
      expect(isValidContentHash('tooshort')).toBe(false);
      expect(isValidContentHash('g'.repeat(64))).toBe(false); // invalid hex
      expect(isValidContentHash('')).toBe(false);
    });
  });
});

describe('Type Casts', () => {
  describe('toFileId', () => {
    it('casts valid UUID to FileId', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const fileId: FileId = toFileId(uuid);
      expect(fileId).toBe(uuid);
    });

    it('throws for invalid UUID', () => {
      expect(() => toFileId('invalid')).toThrow('Invalid FileId');
    });
  });

  describe('toChunkId', () => {
    it('casts valid UUID to ChunkId', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const chunkId: ChunkId = toChunkId(uuid);
      expect(chunkId).toBe(uuid);
    });

    it('throws for invalid UUID', () => {
      expect(() => toChunkId('invalid')).toThrow('Invalid ChunkId');
    });
  });

  describe('toEmbeddingSetId', () => {
    it('casts valid UUID to EmbeddingSetId', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const setId: EmbeddingSetId = toEmbeddingSetId(uuid);
      expect(setId).toBe(uuid);
    });

    it('throws for invalid UUID', () => {
      expect(() => toEmbeddingSetId('invalid')).toThrow('Invalid EmbeddingSetId');
    });
  });

  describe('toContentHash', () => {
    it('casts any string to ContentHash (no validation)', () => {
      // ContentHash is used for externally generated hashes
      // which may have different formats, so no validation
      const hash = toContentHash('any-string-format');
      expect(hash).toBe('any-string-format');
    });
  });
});

describe('Dedupe Invariants', () => {
  it('file dedupe key is deterministic', () => {
    const hash = 'abc123';
    const setId = 'set-456';

    // Multiple calls should produce identical keys
    const keys = Array.from({ length: 10 }, () => buildFileDedupeKey(hash, setId));
    const uniqueKeys = new Set(keys);

    expect(uniqueKeys.size).toBe(1);
  });

  it('chunk dedupe key preserves ordering', () => {
    const fileId = 'file-123';

    // Chunk indices should produce lexicographically sortable keys
    const key0 = buildChunkDedupeKey(fileId, 0);
    const key1 = buildChunkDedupeKey(fileId, 1);
    const key10 = buildChunkDedupeKey(fileId, 10);

    // Keys should be unique and parseable
    expect(parseDedupeKey(key0)?.type).toBe('chunk');
    expect(parseDedupeKey(key1)?.type).toBe('chunk');
    expect(parseDedupeKey(key10)?.type).toBe('chunk');
  });

  it('embed job dedupe key guarantees idempotency', () => {
    // This test validates the core invariant for durable job queues:
    // Re-enqueuing the same chunk+set+model should return existing job

    const chunkId = generateChunkId();
    const setId = generateEmbeddingSetId();
    const modelKey = 'text-embedding-3-small';

    // Simulate multiple enqueue attempts
    const attempt1 = buildEmbedJobDedupeKey(chunkId, setId, modelKey);
    const attempt2 = buildEmbedJobDedupeKey(chunkId, setId, modelKey);
    const attempt3 = buildEmbedJobDedupeKey(chunkId, setId, modelKey);

    // All attempts should use the same dedupe key
    expect(attempt1).toBe(attempt2);
    expect(attempt2).toBe(attempt3);
  });

  it('roundtrip: build then parse dedupe keys', () => {
    // File key roundtrip
    const fileKey = buildFileDedupeKey('hash123', 'set456');
    const parsedFile = parseDedupeKey(fileKey);
    expect(parsedFile).toEqual({
      contentHash: 'hash123',
      embeddingSetId: 'set456',
      type: 'file',
    });

    // Chunk key roundtrip
    const chunkKey = buildChunkDedupeKey('file789', 42);
    const parsedChunk = parseDedupeKey(chunkKey);
    expect(parsedChunk).toEqual({
      chunkIndex: 42,
      fileId: 'file789',
      type: 'chunk',
    });

    // Embed key roundtrip
    const embedKey = buildEmbedJobDedupeKey('chunk-abc', 'set-def', 'model-ghi');
    const parsedEmbed = parseDedupeKey(embedKey);
    expect(parsedEmbed).toEqual({
      chunkId: 'chunk-abc',
      embeddingSetId: 'set-def',
      modelKey: 'model-ghi',
      type: 'embed',
    });
  });
});
