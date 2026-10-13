import { resolve } from 'node:path';
import { resetEmbeddingTelemetryForTests } from '@brainstrike/embedding-worker/testing';
import { beforeEach, vi } from 'vitest';

const {
  commandListenerRef,
  readModelCatalogMock,
  reopenEmbeddingQueueMock,
  queryEmbeddingCancelListenerRef,
  currentDbRef,
  dbHandle,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  getEmbeddingQueueMock,
  retireEmbeddingQueueMock,
  createEmbeddingCacheRepositoryMock,
  detectDeviceCapabilitiesMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  initializeWithModelMock,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
  ipcHandlers,
} = vi.hoisted(() => ({
  commandListenerRef: {
    current: null as null | ((command: unknown) => void),
  },
  createEmbeddingCacheRepositoryMock: vi.fn(),
  currentDbRef: {
    current: null as null | { query: ReturnType<typeof vi.fn> },
  },
  dbHandle: { query: vi.fn() },
  detectDeviceCapabilitiesMock: vi.fn(),
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  embeddingQueueBootstrapMock: vi.fn(),
  ensureVectorPreferencesHydratedMock: vi.fn(),
  generateQueryEmbeddingMock: vi.fn(async () => ({
    embedding: [0.1, 0.2],
    runtime: {
      device: 'webgpu',
      dtype: 'fp32',
      fallbackApplied: false,
    },
  })),
  getEmbeddingQueueMock: vi.fn(() => ({ id: 'embedding-queue' })),
  initializeWithModelMock: vi.fn(async () => {}),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  queryEmbeddingCancelListenerRef: { current: null as null | ((notice: unknown) => void) },
  queryEmbeddingListenerRef: {
    current: null as null | ((request: unknown) => void),
  },
  readModelCatalogMock: vi.fn(),
  reopenEmbeddingQueueMock: vi.fn(),
  reportQueryEmbeddingResponseMock: vi.fn(),
  reportStatusMock: vi.fn(),
  retireEmbeddingQueueMock: vi.fn(async () => {}),
  setDetectedDevicePrefMock: vi.fn(),
  startEmbeddingWorkerMock: vi.fn(),
  stopMock: vi.fn(),
  storeState: {
    devicePref: 'webgpu' as 'wasm' | 'webgpu',
    devicePrefConfigured: true,
    hasHydrated: false,
    reinitEveryN: 200,
    setDetectedDevicePref: vi.fn((devicePref: 'wasm' | 'webgpu') => {
      storeState.devicePref = devicePref;
      setDetectedDevicePrefMock(devicePref);
    }),
  },
}));

const { hostWindow } = vi.hoisted(() => {
  const { EventEmitter } = process.getBuiltinModule('node:events');
  const host = Object.assign(new EventEmitter(), {
    destroy: vi.fn(() => {
      host.destroyed = true;
      host.emit('closed');
    }),
    destroyed: false,
    id: 9176,
    isDestroyed: () => host.destroyed,
    loadURL: vi.fn(async (url: string) => {
      window.history.replaceState({}, '', new URL(url).search);
    }),
    webContents: Object.assign(new EventEmitter(), {
      id: 9176,
      send: vi.fn((_channel: string, command: unknown) => commandListenerRef.current?.(command)),
      setWindowOpenHandler: vi.fn(),
    }),
  });
  return { hostWindow: host };
});

const createHostWindowMock = vi.hoisted(() =>
  vi.fn(function BrowserWindow() {
    hostWindow.removeAllListeners();
    hostWindow.webContents.removeAllListeners();
    hostWindow.destroyed = false;
    return hostWindow;
  })
);

vi.mock('electron', () => ({
  app: { getAppPath: () => resolve('/test/app'), isPackaged: false },
  BrowserWindow: createHostWindowMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
    ),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  powerSaveBlocker: { isStarted: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));

vi.mock('@brainstrike/db', () => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  usePGliteDatabase: () => {
    throw new Error('PGlite is unavailable in the native hidden host');
  },
}));
vi.mock('@brainstrike/db/react', () => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  usePGliteDatabase: () => {
    throw new Error('PGlite is unavailable in the native hidden host');
  },
}));

vi.mock('@brainstrike/app-state/stores/vector-preferences-store', () => ({
  ensureVectorPreferencesHydrated: ensureVectorPreferencesHydratedMock,
  useVectorPreferencesStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    }
  ),
}));

vi.mock('@brainstrike/embeddings', () => ({
  detectDeviceCapabilities: detectDeviceCapabilitiesMock,
}));

vi.mock('@brainstrike/embeddings/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/embeddings/worker')>()),
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('../../../renderer/create-embedding-queue', () => ({
  ...(() => {
    embeddingQueueBootstrapMock();
    return {
      getEmbeddingQueue: getEmbeddingQueueMock,
      reopenEmbeddingQueue: reopenEmbeddingQueueMock,
      retireEmbeddingQueue: retireEmbeddingQueueMock,
    };
  })(),
}));

vi.mock('../../../renderer/components/embedding-worker-config', () => ({
  createEmbeddingWorkerConfig: () => ({
    db: dbHandle,
  }),
}));

export function installEmbeddingHostRuntimeFixture(): void {
  beforeEach(() => {
    hostWindow.removeAllListeners();
    hostWindow.webContents.removeAllListeners();
    vi.clearAllMocks();
    readModelCatalogMock.mockReset().mockResolvedValue({ models: [], providers: [] });
    reopenEmbeddingQueueMock.mockReset().mockImplementation(async (isCurrent: () => boolean) => {
      if (isCurrent()) {
        getEmbeddingQueueMock();
      }
    });
    Object.defineProperty(window, 'modelCatalog', {
      configurable: true,
      value: { read: readModelCatalogMock },
    });
    retireEmbeddingQueueMock.mockReset().mockResolvedValue(undefined);
    reportStatusMock.mockReset();
    stopMock.mockResolvedValue(undefined);
    resetEmbeddingTelemetryForTests();
    currentDbRef.current = dbHandle;
    storeState.hasHydrated = false;
    storeState.devicePref = 'webgpu';
    storeState.devicePrefConfigured = true;
    storeState.reinitEveryN = 200;
    setDetectedDevicePrefMock.mockClear();
    detectDeviceCapabilitiesMock.mockResolvedValue({
      detectedAt: 1,
      recommendationReason: 'test default',
      recommendedDevice: 'webgpu',
      wasmAvailable: true,
      webgpuAdapterAvailable: true,
      webgpuAdapterInfo: null,
      webgpuApiPresent: true,
      webgpuUnavailableReason: null,
      webWorkersAvailable: true,
    });
    ensureVectorPreferencesHydratedMock.mockImplementation(async () => {
      if (!storeState.hasHydrated) {
        throw new Error('Vector preferences store failed to hydrate.');
      }
      return storeState;
    });
    createEmbeddingCacheRepositoryMock.mockReturnValue(embeddingCacheRepository);
    startEmbeddingWorkerMock.mockResolvedValue({
      stop: stopMock,
    });

    Object.defineProperty(window, 'embeddingHost', {
      configurable: true,
      value: {
        onCommand: (callback: (command: unknown) => void) => {
          commandListenerRef.current = callback;
          return () => {
            commandListenerRef.current = null;
          };
        },
        onQueryEmbeddingCancel: (callback: (notice: unknown) => void) => {
          queryEmbeddingCancelListenerRef.current = callback;
          return () => {
            queryEmbeddingCancelListenerRef.current = null;
          };
        },
        onQueryEmbeddingRequest: (callback: (request: unknown) => void) => {
          queryEmbeddingListenerRef.current = callback;
          return () => {
            queryEmbeddingListenerRef.current = null;
          };
        },
        reportQueryEmbeddingResponse: reportQueryEmbeddingResponseMock,
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
}

export {
  commandListenerRef,
  createEmbeddingCacheRepositoryMock,
  createHostWindowMock,
  currentDbRef,
  dbHandle,
  detectDeviceCapabilitiesMock,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  getEmbeddingQueueMock,
  hostWindow,
  initializeWithModelMock,
  ipcHandlers,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  readModelCatalogMock,
  reopenEmbeddingQueueMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
};
