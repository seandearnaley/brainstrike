import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding worker architecture', () => {
  const workerRoot = path.resolve(process.cwd(), 'src/worker');
  const workerSource = (): string =>
    readFileSync(path.join(workerRoot, 'embedding-worker.ts'), 'utf8');

  it('keeps cache contracts in a dedicated module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-cache-types.ts'))).toBe(true);
    expect(workerSource()).not.toContain('export interface EmbeddingCacheInterface');
    expect(workerSource()).not.toContain('export interface CachedEmbedding');
  });

  it('keeps stats refresh scheduling outside the worker lifecycle module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-stats-refresh-controller.ts'))).toBe(true);
    expect(workerSource()).not.toContain('export interface EmbeddingStatsRefreshControllerOptions');
    expect(workerSource()).not.toContain('export function createEmbeddingStatsRefreshController');
  });

  it('keeps model config lookup and cache outside the worker lifecycle module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-model-config.ts'))).toBe(true);
    expect(workerSource()).not.toContain('interface DbModelRow');
    expect(workerSource()).not.toContain('const dbModelConfigCache');
    expect(workerSource()).not.toContain('function parseCapabilities');
    expect(workerSource()).not.toContain('function parseParameters');
    expect(workerSource()).not.toContain('async function getModelConfigFromDb');
    expect(workerSource()).not.toContain('export function clearModelConfigCache');
  });

  it('keeps database IO helpers outside the worker lifecycle module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-worker-db-io.ts'))).toBe(true);
    expect(workerSource()).not.toContain('async function loadChunk');
    expect(workerSource()).not.toContain('async function loadChunksBatch');
    expect(workerSource()).not.toContain('async function resolveIdType');
    expect(workerSource()).not.toContain('async function assertVectorEmbeddingColumn');
    expect(workerSource()).not.toContain('async function updateChunkEmbeddingBatch');
    expect(workerSource()).not.toContain('async function resolveEmbeddingSetDimension');
  });

  it('keeps provider runtime initialization outside the worker lifecycle module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-provider-runtime.ts'))).toBe(true);
    expect(workerSource()).not.toContain('function resolveWorkerModel');
    expect(workerSource()).not.toContain('function ensureLocalRuntime');
    expect(workerSource()).not.toContain('function shouldStartWorker');
    expect(workerSource()).not.toContain('async function initializeEmbeddingService');
    expect(workerSource()).not.toContain('function ensureModelDimension');
    expect(workerSource()).not.toContain('class WorkerRateLimitError');
  });

  it('keeps scheduler, failure, cache, and job payload helpers outside the lifecycle module', () => {
    expect(existsSync(path.join(workerRoot, 'embedding-worker-scheduler.ts'))).toBe(true);
    expect(existsSync(path.join(workerRoot, 'embedding-worker-failures.ts'))).toBe(true);
    expect(existsSync(path.join(workerRoot, 'embedding-worker-cache-io.ts'))).toBe(true);
    expect(existsSync(path.join(workerRoot, 'embedding-worker-job-payload.ts'))).toBe(true);
    expect(existsSync(path.join(workerRoot, 'embedding-worker-chunk-filter.ts'))).toBe(true);

    expect(workerSource()).not.toContain('function resolveIdlePollBackoffOptions');
    expect(workerSource()).not.toContain('function shouldLogIdleBackoff');
    expect(workerSource()).not.toContain('function classifyFailure');
    expect(workerSource()).not.toContain('function summarizeErrorMessage');
    expect(workerSource()).not.toContain('function lookupCacheHits');
    expect(workerSource()).not.toContain('function filterCacheMisses');
    expect(workerSource()).not.toContain('function storeToCacheAsync');
    expect(workerSource()).not.toContain('function reconstructResults');
    expect(workerSource()).not.toContain('function assertEmbedChunkJob');
    expect(workerSource()).not.toContain('function resolveJobModel');
    expect(workerSource()).not.toContain('function loadAndFilterChunks');
    expect(workerSource()).not.toContain('function isEmbeddingUpToDate');
  });

  it('documents worker ownership and focused verification', () => {
    const readmePath = path.join(workerRoot, 'README.md');
    expect(existsSync(readmePath), 'worker must have an ownership README').toBe(true);

    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('## Ownership');
    expect(readme).toContain('## Public surface');
    expect(readme).toContain('## Allowed dependencies');
    expect(readme).toContain('## Focused local test');
  });
});
