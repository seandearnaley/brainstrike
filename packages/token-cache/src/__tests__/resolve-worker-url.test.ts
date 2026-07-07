import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBackgroundIndexerWorkerUrl,
  resolveTokenCacheWorkerUrl,
} from '../resolve-worker-url';

const setImportMetaOverride = (value: unknown) => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = value;
};

const clearImportMetaOverride = () => {
  (globalThis as { __BRAINSTRIKE_IMPORT_META__?: unknown }).__BRAINSTRIKE_IMPORT_META__ = undefined;
};

describe('resolve-worker-url', () => {
  afterEach(() => {
    clearImportMetaOverride();
  });

  it('resolves token cache worker URL from import.meta.url override', () => {
    setImportMetaOverride({ url: 'file:///tmp/module/index.js' });

    const url = resolveTokenCacheWorkerUrl();

    expect(url.href).toBe('file:///tmp/module/token-cache.worker.js');
  });

  it('resolves token cache worker TypeScript URL from source import.meta.url override', () => {
    setImportMetaOverride({ url: 'file:///tmp/module/index.ts' });

    const url = resolveTokenCacheWorkerUrl();

    expect(url.href).toBe('file:///tmp/module/token-cache.worker.ts');
  });

  it('resolves background indexer worker URL from import.meta.dirname override', () => {
    setImportMetaOverride({ dirname: '/tmp/module' });

    const url = resolveBackgroundIndexerWorkerUrl();

    expect(url.href).toBe('file:///tmp/module/background-indexer.worker.js');
  });

  it('resolves background indexer worker TypeScript URL from source import.meta.url override', () => {
    setImportMetaOverride({ url: 'file:///tmp/module/index.ts' });

    const url = resolveBackgroundIndexerWorkerUrl();

    expect(url.href).toBe('file:///tmp/module/background-indexer.worker.ts');
  });

  it('throws a descriptive error when import meta is unavailable', () => {
    setImportMetaOverride({});

    let error: Error | null = null;
    try {
      resolveTokenCacheWorkerUrl();
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('token cache');
    expect(error?.message).toContain('import.meta');
    expect(error?.message).toContain('ESM');
  });

  it('includes worker context in background indexer failures', () => {
    setImportMetaOverride({ dirname: undefined, url: undefined });

    let error: Error | null = null;
    try {
      resolveBackgroundIndexerWorkerUrl();
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain('background indexer');
    expect(error?.message).toContain('import.meta');
  });
});
