import { beforeEach, describe, expect, it, vi } from 'vitest';

const { installChunkLoadErrorListener, markReloadAlreadyAttempted, uninstall } = vi.hoisted(() => ({
  installChunkLoadErrorListener: vi.fn(),
  markReloadAlreadyAttempted: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock('@brainstrike/ui', () => ({
  appReloadStore: { markReloadAlreadyAttempted },
  installChunkLoadErrorListener,
}));

import { CHUNK_RELOAD_STORAGE_KEY } from '../chunk-reload-guard';
import { startAppReloadRecovery } from '../start-app-reload-recovery';

beforeEach(() => {
  vi.clearAllMocks();
  installChunkLoadErrorListener.mockReturnValue(uninstall);
  window.sessionStorage.clear();
});

describe('startAppReloadRecovery', () => {
  it('installs the chunk-load listener on this window', () => {
    startAppReloadRecovery({ buildId: 'build-1' });

    expect(installChunkLoadErrorListener).toHaveBeenCalledExactlyOnceWith(window);
  });

  it('consumes the marker the last reload left, flagging a same-build reload', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-1' }));

    startAppReloadRecovery({ buildId: 'build-1' });

    expect(markReloadAlreadyAttempted).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it('does not flag a reload that landed on a different build', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ buildId: 'build-1' }));

    startAppReloadRecovery({ buildId: 'build-2' });

    expect(markReloadAlreadyAttempted).not.toHaveBeenCalled();
  });

  it('returns the uninstall for an entry that re-executes under HMR', () => {
    const dispose = startAppReloadRecovery({ buildId: 'build-1' });

    dispose();

    expect(uninstall).toHaveBeenCalledTimes(1);
  });
});
