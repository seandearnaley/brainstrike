import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/embedding-worker/vite', () => ({
  resolveEmbeddingWorkerUrlHref: () => 'app://renderer/assets/embedding-worker.js',
}));

describe('resolveEmbeddingWorkerUrlHref', () => {
  it('resolves the embedding worker from the package worker subpath', async () => {
    const { resolveEmbeddingWorkerUrlHref } = await import('../resolve-embedding-worker-url');

    expect(resolveEmbeddingWorkerUrlHref()).toBe('app://renderer/assets/embedding-worker.js');
  });

  it('does not couple the desktop app to the embedding-worker source layout', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../resolve-embedding-worker-url.ts'),
      'utf8'
    );

    expect(source).toContain("from '@brainstrike/embedding-worker/vite'");
    expect(source).not.toContain('packages/embedding-worker/src');
  });
});
