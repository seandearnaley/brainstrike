import type { LogRecord } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The registry and the reload store are module-level state, so every test loads
 * a fresh module graph (the `use-app-active` house style) instead of a reset hook.
 */
async function loadFresh() {
  vi.resetModules();
  const [chunkLoad, logging] = await Promise.all([
    import('../index'),
    import('@brainstrike/logging'),
  ]);
  return { ...chunkLoad, addLogListener: logging.addLogListener };
}

/** The runtime shape of Vite's `handlePreloadError`: a cancelable Event with `payload` assigned. */
function dispatchPreloadError(payload: unknown): Event {
  const event = new Event('vite:preloadError', { cancelable: true });
  Object.assign(event, { payload });
  window.dispatchEvent(event);
  return event;
}

describe('installChunkLoadErrorListener', () => {
  const uninstalls: Array<() => void> = [];
  afterEach(() => {
    for (const uninstall of uninstalls.splice(0)) {
      uninstall();
    }
  });

  it('registers the vite:preloadError payload as a chunk-load error', async () => {
    const { installChunkLoadErrorListener, isChunkLoadError } = await loadFresh();
    uninstalls.push(installChunkLoadErrorListener(window));
    const payload = new TypeError('Failed to fetch dynamically imported module');

    dispatchPreloadError(payload);

    expect(isChunkLoadError(payload)).toBe(true);
  });

  it('does not treat an unrelated error as a chunk-load error, whatever its message says', async () => {
    const { installChunkLoadErrorListener, isChunkLoadError } = await loadFresh();
    uninstalls.push(installChunkLoadErrorListener(window));
    dispatchPreloadError(new Error('registered'));

    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    // Identity, never message strings: a lookalike that Vite never reported stays false.
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module'))).toBe(
      false
    );
  });

  it('rejects values that cannot be chunk-load errors', async () => {
    const { isChunkLoadError } = await loadFresh();

    for (const value of [undefined, null, 'chunk failed', 42, {}]) {
      expect(isChunkLoadError(value)).toBe(false);
    }
  });

  it('matches an error whose cause chain contains the payload', async () => {
    const { installChunkLoadErrorListener, isChunkLoadError } = await loadFresh();
    uninstalls.push(installChunkLoadErrorListener(window));
    const payload = new Error('chunk');
    dispatchPreloadError(payload);

    const wrapped = new Error('wrapper', { cause: payload });
    const doublyWrapped = new Error('outer', { cause: wrapped });

    expect(isChunkLoadError(wrapped)).toBe(true);
    expect(isChunkLoadError(doublyWrapped)).toBe(true);
  });

  it('terminates on a cyclic cause chain', async () => {
    const { isChunkLoadError } = await loadFresh();
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    // A walk without a visited set would spin forever; the getter fails it fast instead.
    let reads = 0;
    Object.defineProperty(first, 'cause', {
      get: () => {
        reads += 1;
        if (reads > 10) {
          throw new Error('cause chain was walked in a cycle');
        }
        return second;
      },
    });

    expect(isChunkLoadError(first)).toBe(false);
  });

  it('never calls preventDefault, which would make the import resolve to undefined', async () => {
    const { installChunkLoadErrorListener } = await loadFresh();
    uninstalls.push(installChunkLoadErrorListener(window));

    const event = dispatchPreloadError(new Error('chunk'));

    expect(event.defaultPrevented).toBe(false);
  });

  it('flags the app as needing a reload', async () => {
    const { appReloadStore, installChunkLoadErrorListener } = await loadFresh();
    uninstalls.push(installChunkLoadErrorListener(window));
    expect(appReloadStore.getSnapshot().required).toBe(false);

    dispatchPreloadError(new Error('chunk'));

    expect(appReloadStore.getSnapshot().required).toBe(true);
  });

  it('stops listening once uninstalled', async () => {
    const { appReloadStore, installChunkLoadErrorListener, isChunkLoadError } = await loadFresh();
    const uninstall = installChunkLoadErrorListener(window);
    uninstall();
    const payload = new Error('chunk');

    dispatchPreloadError(payload);

    expect(isChunkLoadError(payload)).toBe(false);
    expect(appReloadStore.getSnapshot().required).toBe(false);
  });

  it('logs a non-object payload, which cannot be registered, and still flags the reload', async () => {
    const { addLogListener, appReloadStore, installChunkLoadErrorListener } = await loadFresh();
    const records: LogRecord[] = [];
    uninstalls.push(addLogListener((record) => records.push(record)));
    uninstalls.push(installChunkLoadErrorListener(window));

    const event = dispatchPreloadError('Failed to fetch');

    expect(records.some((record) => record.message?.includes('non-object payload'))).toBe(true);
    expect(appReloadStore.getSnapshot().required).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});
