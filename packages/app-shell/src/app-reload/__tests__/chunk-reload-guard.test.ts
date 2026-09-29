import { clearPersistentUiState } from '@brainstrike/app-state/factory-reset';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, markReloadAlreadyAttempted } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  markReloadAlreadyAttempted: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
// The guard's contract with the store is one call; the store has its own tests.
vi.mock('@brainstrike/ui', () => ({ appReloadStore: { markReloadAlreadyAttempted } }));

import {
  CHUNK_RELOAD_STORAGE_KEY,
  consumeChunkReloadMarker,
  writeChunkReloadMarker,
} from '../chunk-reload-guard';

/** A blocked or full store throws a DOMException, not a plain Error. */
function storageFailure(name: 'QuotaExceededError' | 'SecurityError'): DOMException {
  return new DOMException(`${name} from test`, name);
}

function failingStorage(
  failing: 'getItem' | 'removeItem' | 'setItem',
  seed: string | null = null
): Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> {
  const error = storageFailure(failing === 'setItem' ? 'QuotaExceededError' : 'SecurityError');
  return {
    getItem: () => {
      if (failing === 'getItem') {
        throw error;
      }
      return seed;
    },
    removeItem: () => {
      if (failing === 'removeItem') {
        throw error;
      }
    },
    setItem: () => {
      if (failing === 'setItem') {
        throw error;
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe('consumeChunkReloadMarker', () => {
  it('flags the reload as already attempted when the marker names this build', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-1' }));

    consumeChunkReloadMarker({ buildId: 'build-1' });

    expect(markReloadAlreadyAttempted).toHaveBeenCalledTimes(1);
  });

  it('leaves the reload unflagged when the marker names a different build', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-1' }));

    consumeChunkReloadMarker({ buildId: 'build-2' });

    expect(markReloadAlreadyAttempted).not.toHaveBeenCalled();
  });

  it('deletes the marker whether or not it matched', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-1' }));
    consumeChunkReloadMarker({ buildId: 'build-2' });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-2' }));
    consumeChunkReloadMarker({ buildId: 'build-2' });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it('does nothing, quietly, when there is no marker', () => {
    consumeChunkReloadMarker({ buildId: 'build-1' });

    expect(markReloadAlreadyAttempted).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable text', 'not json {'],
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['an object without a buildId', '{"other":1}'],
    ['a non-string buildId', '{"buildId":5}'],
  ])('logs and deletes a malformed marker (%s), and does not flag the reload', (_label, raw) => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, raw);

    consumeChunkReloadMarker({ buildId: 'build-1' });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
    expect(markReloadAlreadyAttempted).not.toHaveBeenCalled();
  });

  it('logs a read failure and continues without flagging', () => {
    expect(() =>
      consumeChunkReloadMarker({ buildId: 'build-1', getStorage: () => failingStorage('getItem') })
    ).not.toThrow();

    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('read'), {
      error: expect.any(DOMException),
    });
    expect(markReloadAlreadyAttempted).not.toHaveBeenCalled();
  });

  it('logs a storage that cannot even be reached and continues', () => {
    const error = storageFailure('SecurityError');

    expect(() =>
      consumeChunkReloadMarker({
        buildId: 'build-1',
        getStorage: () => {
          throw error;
        },
      })
    ).not.toThrow();

    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('reach'), { error });
  });

  it('logs a delete failure and still honours a matching marker', () => {
    const storage = failingStorage('removeItem', JSON.stringify({ buildId: 'build-1' }));

    expect(() =>
      consumeChunkReloadMarker({ buildId: 'build-1', getStorage: () => storage })
    ).not.toThrow();

    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('delete'), {
      error: expect.any(DOMException),
    });
    expect(markReloadAlreadyAttempted).toHaveBeenCalledTimes(1);
  });
});

describe('writeChunkReloadMarker', () => {
  it('records the build id under the marker key', () => {
    writeChunkReloadMarker({ buildId: 'build-1' });

    expect(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY) ?? 'null')).toEqual({
      buildId: 'build-1',
    });
  });

  it('logs a write failure and continues', () => {
    expect(() =>
      writeChunkReloadMarker({ buildId: 'build-1', getStorage: () => failingStorage('setItem') })
    ).not.toThrow();

    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('write'), {
      error: expect.any(DOMException),
    });
  });

  it('logs a storage that cannot be reached and continues', () => {
    const error = storageFailure('SecurityError');

    expect(() =>
      writeChunkReloadMarker({
        buildId: 'build-1',
        getStorage: () => {
          throw error;
        },
      })
    ).not.toThrow();

    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('reach'), { error });
  });

  it('round-trips into a matching consume', () => {
    writeChunkReloadMarker({ buildId: 'build-1' });

    consumeChunkReloadMarker({ buildId: 'build-1' });

    expect(markReloadAlreadyAttempted).toHaveBeenCalledTimes(1);
  });
});

describe('factory reset', () => {
  it('clears the marker with the blanket sessionStorage wipe, so it needs no per-key wiring', async () => {
    writeChunkReloadMarker({ buildId: 'build-1' });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).not.toBeNull();

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });
});
