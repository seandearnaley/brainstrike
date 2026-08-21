import type { Job } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { assertEmbedChunkJob } from '../worker/embedding-worker-job-payload.js';

function embeddingJob(payload: unknown): Job {
  return {
    attempts: 0,
    backoff_ms: 0,
    chunk_id: 'chunk-1',
    created_at: '2026-08-21T00:00:00.000Z',
    dedupe_key: 'chunk-1:set-1:content-hash',
    embedding_set_id: 'set-1',
    error: null,
    id: 'job-1',
    jobType: 'embed_chunk',
    lease_token: null,
    leasedUntil: null,
    max_attempts: 3,
    payload,
    queue: 'embeddings',
    runAt: '2026-08-21T00:00:00.000Z',
    state: 'queued',
    updated_at: '2026-08-21T00:00:00.000Z',
    worker_id: null,
  };
}

describe('embedding worker job payload', () => {
  it('rejects persisted jobs without an upstream embedding input hash', () => {
    expect(() =>
      assertEmbedChunkJob(
        embeddingJob({
          chunkId: 'chunk-1',
          embeddingSetId: 'set-1',
          expectedDimension: 768,
          modelKey: 'local::bge-m3',
          sourceContentHash: 'content-hash',
        })
      )
    ).toThrow('Missing embeddingInputHash in payload');
  });

  it('accepts a lowercase SHA-256 embedding input hash', () => {
    const embeddingInputHash = 'a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df';

    expect(
      assertEmbedChunkJob(
        embeddingJob({
          chunkId: 'chunk-1',
          embeddingInputHash,
          embeddingSetId: 'set-1',
          expectedDimension: 768,
          modelKey: 'local::bge-m3',
          sourceContentHash: 'content-hash',
        })
      )
    ).toMatchObject({ embeddingInputHash });
  });

  it('rejects malformed embedding input hashes', () => {
    expect(() =>
      assertEmbedChunkJob(
        embeddingJob({
          chunkId: 'chunk-1',
          embeddingInputHash: 'not-a-sha256',
          embeddingSetId: 'set-1',
          expectedDimension: 768,
          modelKey: 'local::bge-m3',
          sourceContentHash: 'content-hash',
        })
      )
    ).toThrow('Invalid embeddingInputHash in payload');
  });

  it('rejects persisted jobs without the source content identity', () => {
    expect(() =>
      assertEmbedChunkJob(
        embeddingJob({
          chunkId: 'chunk-1',
          embeddingInputHash: 'a80aabf0d21d49164154d0972531edf40605eb595aff029c37bc74ca083a98df',
          embeddingSetId: 'set-1',
          expectedDimension: 768,
          modelKey: 'local::bge-m3',
        })
      )
    ).toThrow('Missing sourceContentHash in payload');
  });
});
