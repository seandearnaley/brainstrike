import { describe, expect, it, vi } from 'vitest';
import { createLazyStateStorage, type StateStorage } from '../lazy-state-storage';

function createStorage(): StateStorage {
  return {
    getItem: vi.fn((name: string) => `value:${name}`),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
}

describe('createLazyStateStorage', () => {
  it('defers factory resolution until the first operation and resolves exactly once', () => {
    const storage = createStorage();
    const factory = vi.fn(() => storage);
    const lazyStorage = createLazyStateStorage(factory);

    expect(factory).not.toHaveBeenCalled();

    expect(lazyStorage.getItem('first')).toBe('value:first');
    lazyStorage.setItem('second', 'value');
    lazyStorage.removeItem('third');

    expect(factory).toHaveBeenCalledOnce();
    expect(storage.getItem).toHaveBeenCalledWith('first');
    expect(storage.setItem).toHaveBeenCalledWith('second', 'value');
    expect(storage.removeItem).toHaveBeenCalledWith('third');
  });

  it('retries resolution after a factory failure', () => {
    const resolutionError = new Error('adapter unavailable');
    const storage = createStorage();
    const factory = vi
      .fn<() => StateStorage>()
      .mockImplementationOnce(() => {
        throw resolutionError;
      })
      .mockReturnValue(storage);
    const lazyStorage = createLazyStateStorage(factory);

    expect(() => lazyStorage.getItem('first')).toThrow(resolutionError);
    expect(lazyStorage.getItem('second')).toBe('value:second');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it.each([
    'getItem',
    'setItem',
    'removeItem',
  ] as const)('surfaces %s operation errors unchanged', (operation) => {
    const operationError = new Error(`${operation} failed`);
    const storage: StateStorage = {
      getItem: (name: string) => {
        if (operation === 'getItem') {
          throw operationError;
        }
        return `value:${name}`;
      },
      removeItem: () => {
        if (operation === 'removeItem') {
          throw operationError;
        }
      },
      setItem: () => {
        if (operation === 'setItem') {
          throw operationError;
        }
      },
    };
    const lazyStorage = createLazyStateStorage(() => storage);

    const invoke = (): unknown => {
      if (operation === 'getItem') {
        return lazyStorage.getItem('key');
      }
      if (operation === 'setItem') {
        return lazyStorage.setItem('key', 'value');
      }
      return lazyStorage.removeItem('key');
    };

    expect(invoke).toThrow(operationError);
  });
});
