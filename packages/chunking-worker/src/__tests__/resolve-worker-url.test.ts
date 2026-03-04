import { afterEach, describe, expect, it } from 'vitest';
import { resolveChunkingWorkerUrl } from '../index';

const setImportMetaOverride = (value: unknown) => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = value;
};

const clearImportMetaOverride = () => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = undefined;
};

describe('resolveChunkingWorkerUrl', () => {
  afterEach(() => {
    clearImportMetaOverride();
  });

  it('resolves from import.meta.url when provided', () => {
    setImportMetaOverride({ url: 'file:///tmp/chunking/index.js' });

    const url = resolveChunkingWorkerUrl();

    expect(url.href).toBe('file:///tmp/chunking/chunking.worker.js');
  });

  it('falls back to import.meta.dirname when url is missing', () => {
    setImportMetaOverride({ dirname: '/tmp/chunking' });

    const url = resolveChunkingWorkerUrl();

    expect(url.href).toBe('file:///tmp/chunking/chunking.worker.js');
  });

  it('uses native import.meta.url when no override is provided', () => {
    clearImportMetaOverride();

    const url = resolveChunkingWorkerUrl();

    expect(url.href).toContain('/chunking.worker.js');
  });

  it('ignores non-object override values and still resolves', () => {
    setImportMetaOverride('invalid-override');

    const url = resolveChunkingWorkerUrl();

    expect(url.href).toContain('/chunking.worker.js');
  });

  it('throws descriptive errors when import meta is unavailable', () => {
    setImportMetaOverride({});

    expect(() => resolveChunkingWorkerUrl()).toThrow('chunking worker URL');
    expect(() => resolveChunkingWorkerUrl()).toThrow('import.meta');
    expect(() => resolveChunkingWorkerUrl()).toThrow('ESM');
  });
});
