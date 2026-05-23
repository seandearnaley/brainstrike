import { afterEach, describe, expect, it } from 'vitest';
import { resolveFileTreeWorkerUrl } from './index';

const setImportMetaOverride = (value: unknown) => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = value;
};

const clearImportMetaOverride = () => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = undefined;
};

describe('resolveFileTreeWorkerUrl', () => {
  afterEach(() => {
    clearImportMetaOverride();
  });

  it('resolves from import.meta.url when provided', () => {
    setImportMetaOverride({ url: 'file:///tmp/file-tree/index.js' });

    const url = resolveFileTreeWorkerUrl();

    expect(url.href).toBe('file:///tmp/file-tree/file-tree.worker.js');
  });

  it('resolves package-built worker path from source import.meta.url overrides', () => {
    setImportMetaOverride({ url: 'file:///tmp/file-tree/index.ts' });

    const url = resolveFileTreeWorkerUrl();

    expect(url.href).toBe('file:///tmp/file-tree/file-tree.worker.js');
  });

  it('falls back to import.meta.dirname when url is missing', () => {
    setImportMetaOverride({ dirname: '/tmp/file-tree' });

    const url = resolveFileTreeWorkerUrl();

    expect(url.href).toBe('file:///tmp/file-tree/file-tree.worker.js');
  });

  it('throws descriptive errors when import meta is unavailable', () => {
    setImportMetaOverride({});

    expect(() => resolveFileTreeWorkerUrl()).toThrow('file tree worker URL');
    expect(() => resolveFileTreeWorkerUrl()).toThrow('import.meta');
    expect(() => resolveFileTreeWorkerUrl()).toThrow('ESM');
  });
});
