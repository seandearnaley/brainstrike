// BST-568 slice 2: explicit per-OS backend selection + lazy binding load.
// No silent fallback anywhere: unsupported platforms and load failures throw
// typed errors instead of degrading.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParcelWatcherUnavailableError, selectParcelBackend } from '../adapters/parcel-backend';

describe('selectParcelBackend', () => {
  it('maps darwin to fs-events', () => {
    expect(selectParcelBackend('darwin')).toBe('fs-events');
  });

  it('maps linux to inotify', () => {
    expect(selectParcelBackend('linux')).toBe('inotify');
  });

  it('maps win32 to windows', () => {
    expect(selectParcelBackend('win32')).toBe('windows');
  });

  it('throws a typed unsupported-platform error for anything else', () => {
    let thrown: unknown;
    try {
      selectParcelBackend('freebsd');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ParcelWatcherUnavailableError);
    expect((thrown as ParcelWatcherUnavailableError).code).toBe('unsupported-platform');
    expect((thrown as ParcelWatcherUnavailableError).message).toContain('freebsd');
  });
});

describe('loadParcelWatcher', () => {
  afterEach(() => {
    vi.doUnmock('@parcel/watcher');
    vi.resetModules();
  });

  it('resolves the real module and caches the promise', async () => {
    vi.resetModules();
    const { loadParcelWatcher } = await import('../adapters/parcel-backend');
    const first = loadParcelWatcher();
    const second = loadParcelWatcher();
    expect(first).toBe(second);
    const mod = await first;
    expect(typeof mod.subscribe).toBe('function');
  });

  it('wraps a load failure in a typed binding-load-failed error with cause', async () => {
    vi.resetModules();
    vi.doMock('@parcel/watcher', () => {
      throw new Error('No prebuild for exotic-arch');
    });
    const { loadParcelWatcher: load, ParcelWatcherUnavailableError: TypedError } = await import(
      '../adapters/parcel-backend'
    );
    let thrown: unknown;
    try {
      await load();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypedError);
    expect((thrown as InstanceType<typeof TypedError>).code).toBe('binding-load-failed');
    // vitest wraps mock-factory failures; the original error must remain
    // reachable somewhere on the cause chain.
    const causeChain: string[] = [];
    let cursor: unknown = (thrown as Error).cause;
    while (cursor instanceof Error) {
      causeChain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(causeChain.length).toBeGreaterThan(0);
    expect(causeChain.join(' | ')).toContain('exotic-arch');
  });
});
