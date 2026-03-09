import { afterEach, describe, expect, it } from 'vitest';
import { resolveEmbeddingWorkerUrl } from '../src';

const setImportMetaOverride = (value: unknown) => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = value;
};

const clearImportMetaOverride = () => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = undefined;
};

describe('resolveEmbeddingWorkerUrl override paths', () => {
  afterEach(() => {
    clearImportMetaOverride();
  });

  it('resolves from import.meta.url when provided', () => {
    setImportMetaOverride({ url: 'file:///tmp/embedding/index.js' });

    const url = resolveEmbeddingWorkerUrl();

    expect(url.href).toBe('file:///tmp/embedding/embedding.worker.js');
  });

  it('resolves TypeScript worker path from source import.meta.url overrides', () => {
    setImportMetaOverride({ url: 'file:///tmp/embedding/index.ts' });

    const url = resolveEmbeddingWorkerUrl();

    expect(url.href).toBe('file:///tmp/embedding/embedding.worker.ts');
  });

  it('falls back to import.meta.dirname when url is missing', () => {
    setImportMetaOverride({ dirname: '/tmp/embedding' });

    const url = resolveEmbeddingWorkerUrl();

    expect(url.href).toBe('file:///tmp/embedding/embedding.worker.js');
  });

  it('throws descriptive errors when import meta is unavailable', () => {
    setImportMetaOverride({});

    expect(() => resolveEmbeddingWorkerUrl()).toThrow('embedding worker URL');
    expect(() => resolveEmbeddingWorkerUrl()).toThrow('import.meta');
    expect(() => resolveEmbeddingWorkerUrl()).toThrow('ESM');
  });
});
