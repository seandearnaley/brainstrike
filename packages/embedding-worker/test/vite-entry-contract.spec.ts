import { describe, expect, it } from 'vitest';
import { resolveViteEmbeddingWorkerUrlHref } from '../src/vite';

describe('Vite embedding worker entry contract', () => {
  it('resolves the worker through Vite asset handling', () => {
    const workerUrl = resolveViteEmbeddingWorkerUrlHref();

    expect(workerUrl).toMatch(/embedding\.worker/);
    expect(workerUrl).not.toContain('packages/embedding-worker/src');
  });
});
