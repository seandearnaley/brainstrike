import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadGetter() {
  vi.resetModules();
  const module = await import('../embedding-host-database-integrity');
  return module.getEmbeddingHostIntegrityWatcher;
}

describe('getEmbeddingHostIntegrityWatcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails visibly when the preload did not expose the integrity bridge', async () => {
    vi.stubGlobal('window', {});
    const getEmbeddingHostIntegrityWatcher = await loadGetter();

    expect(() => getEmbeddingHostIntegrityWatcher()).toThrow(
      'Desktop embedding host requires the database integrity bridge.'
    );
  });

  it('creates one watcher over the bridge and shares it', async () => {
    const onChanged = vi.fn(() => () => undefined);
    vi.stubGlobal('window', { databaseIntegrity: { getState: vi.fn(), onChanged } });
    const getEmbeddingHostIntegrityWatcher = await loadGetter();

    const first = getEmbeddingHostIntegrityWatcher();

    expect(getEmbeddingHostIntegrityWatcher()).toBe(first);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('hands out no dispose: the claim permit relies on this watcher for the life of the host', async () => {
    vi.stubGlobal('window', {
      databaseIntegrity: { getState: vi.fn(), onChanged: vi.fn(() => () => undefined) },
    });
    const getEmbeddingHostIntegrityWatcher = await loadGetter();

    expect(getEmbeddingHostIntegrityWatcher()).not.toHaveProperty('dispose');
  });
});
