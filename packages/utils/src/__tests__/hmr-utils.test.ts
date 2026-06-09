import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHMRModule, type HMRModule, isHMRAvailable, setupHMR } from '../dev/hmr-utils';

function installViteHot(hot: HMRModule | undefined): void {
  Object.defineProperty(globalThis, '__vite_hot__', {
    configurable: true,
    value: hot,
  });
}

describe('hmr-utils', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__vite_hot__');
    vi.restoreAllMocks();
  });

  it('returns the Vite global HMR module when it has the expected API', () => {
    const hot: HMRModule = {
      accept: vi.fn(),
      dispose: vi.fn(),
    };
    installViteHot(hot);

    expect(getHMRModule()).toBe(hot);
    expect(isHMRAvailable()).toBe(true);
  });

  it('ignores malformed or throwing global HMR shims', () => {
    installViteHot({ accept: vi.fn() } as unknown as HMRModule);
    expect(getHMRModule()).toBeNull();

    Object.defineProperty(globalThis, '__vite_hot__', {
      configurable: true,
      get: () => {
        throw new Error('hmr getter failed');
      },
    });
    expect(getHMRModule()).toBeNull();
  });

  it('wires accept and dispose callbacks only when HMR is available', () => {
    const hot: HMRModule = {
      accept: vi.fn(),
      dispose: vi.fn(),
    };
    const onAccept = vi.fn();
    const onDispose = vi.fn();
    installViteHot(hot);

    setupHMR(onAccept, onDispose);

    expect(hot.accept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(hot.dispose).toHaveBeenCalledWith(onDispose);

    Reflect.deleteProperty(globalThis, '__vite_hot__');
    setupHMR(onAccept, onDispose);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
