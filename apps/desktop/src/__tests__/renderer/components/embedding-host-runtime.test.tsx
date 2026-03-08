import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';

const {
  dbHandle,
  ensureVectorPreferencesHydratedMock,
  reportStatusMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
} = vi.hoisted(() => ({
  dbHandle: { query: vi.fn() },
  ensureVectorPreferencesHydratedMock: vi.fn(),
  reportStatusMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
  stopMock: vi.fn(),
  storeState: {
    hasHydrated: false,
    devicePref: 'webgpu' as 'wasm' | 'webgpu',
  },
}));

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => dbHandle,
}));

vi.mock('@brainstrike/preferences', () => ({
  ensureVectorPreferencesHydrated: ensureVectorPreferencesHydratedMock,
  useVectorPreferencesStore: (selector: (state: typeof storeState) => unknown) =>
    selector(storeState),
}));

vi.mock('@brainstrike/embeddings', () => ({
  POWER_BROADCAST_CHANNEL: 'brainstrike-test-power',
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('../../../renderer/components/embedding-worker-config', () => ({
  createEmbeddingWorkerConfig: () => ({
    db: dbHandle,
  }),
}));

describe('EmbeddingHostRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.hasHydrated = false;
    storeState.devicePref = 'webgpu';
    ensureVectorPreferencesHydratedMock.mockImplementation(async () => {
      if (!storeState.hasHydrated) {
        throw new Error('Vector preferences store failed to hydrate.');
      }
      return storeState;
    });
    startEmbeddingWorkerMock.mockResolvedValue({
      stop: stopMock,
    });

    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        onCommand: () => () => {},
        reportStatus: reportStatusMock,
      },
    });

    Object.defineProperty(window, 'power', {
      configurable: true,
      value: {
        onPowerState: () => () => {},
      },
    });

    window.history.replaceState({}, '', '/?mode=embedding-host&runtimeId=test-runtime');
  });

  it('waits for vector preference hydration before starting the worker', async () => {
    let resolveHydration: ((value: typeof storeState) => void) | null = null;
    ensureVectorPreferencesHydratedMock.mockImplementation(
      () =>
        new Promise<typeof storeState>((resolve) => {
          resolveHydration = resolve;
        })
    );

    render(<EmbeddingHostRuntime />);

    expect(startEmbeddingWorkerMock).not.toHaveBeenCalled();
    expect(ensureVectorPreferencesHydratedMock).toHaveBeenCalledTimes(1);

    storeState.hasHydrated = true;
    storeState.devicePref = 'wasm';
    resolveHydration?.(storeState);

    await waitFor(() => {
      expect(startEmbeddingWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          device: 'wasm',
          initializeLocalModelOnStart: false,
        })
      );
    });
  });
});
