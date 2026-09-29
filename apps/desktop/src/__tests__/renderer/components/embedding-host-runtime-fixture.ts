import { resetEmbeddingTelemetryForTests } from '@brainstrike/embedding-worker/testing';
import { beforeEach, vi } from 'vitest';

const {
  commandListenerRef,
  currentDbRef,
  dbHandle,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  getEmbeddingQueueMock,
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
  queryEmbeddingListenerRef: {
    current: null as null | ((request: unknown) => void),
  },
  reportQueryEmbeddingResponseMock: vi.fn(),
  reportStatusMock: vi.fn(),
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
  const listeners = new Map<string, () => void>();
  const host = {
    destroy: vi.fn(() => {
      host.destroyed = true;
      listeners.get('closed')?.();
    }),
    destroyed: false,
    id: 9176,
    isDestroyed: () => host.destroyed,
    loadURL: vi.fn(async (url: string) => {
      window.history.replaceState({}, '', new URL(url).search);
    }),
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    once: (name: string, listener: () => void) => listeners.set(name, listener),
    webContents: {
      id: 9176,
      on: vi.fn(),
      send: vi.fn((_channel: string, command: unknown) => commandListenerRef.current?.(command)),
      setWindowOpenHandler: vi.fn(),
    },
  };
  return { hostWindow: host };
});

const createHostWindowMock = vi.hoisted(() =>
  vi.fn(function BrowserWindow() {
    hostWindow.destroyed = false;
    return hostWindow;
  })
);

vi.mock('electron', () => ({
  app: { getAppPath: () => '/test/app', isPackaged: false },
  BrowserWindow: createHostWindowMock,
  powerSaveBlocker: { isStarted: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));

vi.mock('@brainstrike/db', async (importOriginal) => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  // The real priority proxy: the runtime's model read must reach the handle
  // with the foreground lane's work options.
  createPriorityDbHandle: (await importOriginal<typeof import('@brainstrike/db')>())
    .createPriorityDbHandle,
  usePGliteDatabase: () => currentDbRef.current,
}));
vi.mock('@brainstrike/db/react', () => ({
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  usePGliteDatabase: () => currentDbRef.current,
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

vi.mock('@brainstrike/embeddings/worker', () => ({
  createForegroundEmbeddingGate: () => ({
    begin: () => {},
    end: () => {},
    isActive: () => false,
    waitUntilInactive: async () => {},
  }),
  POWER_BROADCAST_CHANNEL: 'brainstrike-test-power',
  runCoordinatedQueryEmbedding: async (options: { generate: () => Promise<unknown> }) =>
    options.generate(),
  startEmbeddingWorker: startEmbeddingWorkerMock,
}));

vi.mock('@brainstrike/embeddings/service', () => ({
  SimpleEmbeddingService: class {
    initializeWithModel = initializeWithModelMock;
    generateQueryEmbedding = generateQueryEmbeddingMock;
    dispose = vi.fn(async () => {});
  },
}));

vi.mock('../../../renderer/create-embedding-queue', () => ({
  ...(() => {
    embeddingQueueBootstrapMock();
    return {
      getEmbeddingQueue: getEmbeddingQueueMock,
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
    vi.clearAllMocks();
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
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
};
