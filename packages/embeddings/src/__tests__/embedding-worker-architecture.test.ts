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
