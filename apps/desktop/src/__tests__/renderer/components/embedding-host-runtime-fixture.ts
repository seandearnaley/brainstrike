import { resolve } from 'node:path';
import { resetEmbeddingTelemetryForTests } from '@brainstrike/embedding-worker/testing';
import { beforeEach, vi } from 'vitest';

const {
  commandListenerRef,
  currentDbRef,
  dbHandle,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  getEmbeddingQueueMock,
  retireEmbeddingQueueMock,
  createEmbeddingCacheRepositoryMock,
  detectDeviceCapabilitiesMock,
  disposeQueryEmbeddingServiceMock,
  ensureVectorPreferencesHydratedMock,
  generateQueryEmbeddingMock,
  generateDocumentEmbeddingsMock,
  documentEmbeddingsListenerRef,
  documentEmbeddingsCancelListenerRef,
  reportDocumentEmbeddingsResponseMock,
  initializeMock,
  initializeWithModelMock,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  reportWebgpuAdapterResponseMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
  webgpuAdapterListenerRef,
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
  disposeQueryEmbeddingServiceMock: vi.fn(async () => {}),
  documentEmbeddingsCancelListenerRef: { current: null as null | ((notice: unknown) => void) },
  documentEmbeddingsListenerRef: { current: null as null | ((request: unknown) => void) },
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  embeddingQueueBootstrapMock: vi.fn(),
  ensureVectorPreferencesHydratedMock: vi.fn(),
  generateDocumentEmbeddingsMock:
    vi.fn<(...args: unknown[]) => Promise<import('@brainstrike/embeddings').EmbeddingResult[]>>(),
  generateQueryEmbeddingMock: vi.fn<
    () => Promise<{
      embedding: number[];
      runtime?:
        | {
            device: string;
            dtype: string;
            fallbackApplied: boolean;
            pooling?: string;
            revision?: string;
          }
        | undefined;
    }>
  >(async () => ({
    embedding: [0.1, 0.2],
    runtime: {
      device: 'webgpu',
      dtype: 'fp32',
      fallbackApplied: false,
      pooling: 'mean',
    },
  })),
  getEmbeddingQueueMock: vi.fn(() => ({ id: 'embedding-queue' })),
  initializeMock: vi.fn(async () => {}),
  initializeWithModelMock: vi.fn(async () => {}),
  queryEmbeddingListenerRef: {
    current: null as null | ((request: unknown) => void),
  },
  reportDocumentEmbeddingsResponseMock: vi.fn(),
  reportQueryEmbeddingResponseMock: vi.fn(),
  reportStatusMock: vi.fn(),
  reportWebgpuAdapterResponseMock: vi.fn(),
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
  webgpuAdapterListenerRef: {
    current: null as null | ((request: unknown) => void),
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
    initialize = initializeMock;
    initializeWithModel = initializeWithModelMock;
    generateQueryEmbedding = generateQueryEmbeddingMock;
    generateEmbeddings = generateDocumentEmbeddingsMock;
    dispose = disposeQueryEmbeddingServiceMock;
  },
}));

vi.mock('../../../renderer/create-embedding-queue', () => ({
  ...(() => {
    embeddingQueueBootstrapMock();
    return {
      getEmbeddingQueue: getEmbeddingQueueMock,
      reopenEmbeddingQueue: async (isCurrent: () => boolean) => {
        if (isCurrent()) {
          getEmbeddingQueueMock();
        }
      },
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
    retireEmbeddingQueueMock.mockReset().mockResolvedValue(undefined);
    generateDocumentEmbeddingsMock.mockReset();
    reportStatusMock.mockReset();
    reportWebgpuAdapterResponseMock.mockReset();
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
        onDocumentEmbeddingsCancel: (callback: (notice: unknown) => void) => {
          documentEmbeddingsCancelListenerRef.current = callback;
          return () => {
            documentEmbeddingsCancelListenerRef.current = null;
          };
        },
        onDocumentEmbeddingsRequest: (callback: (request: unknown) => void) => {
          documentEmbeddingsListenerRef.current = callback;
          return () => {
            documentEmbeddingsListenerRef.current = null;
          };
        },
        onQueryEmbeddingCancel: () => () => {},
        onQueryEmbeddingRequest: (callback: (request: unknown) => void) => {
          queryEmbeddingListenerRef.current = callback;
          return () => {
            queryEmbeddingListenerRef.current = null;
          };
        },
        onWebgpuAdapterRequest: (callback: (request: unknown) => void) => {
          webgpuAdapterListenerRef.current = callback;
          return () => {
            webgpuAdapterListenerRef.current = null;
          };
        },
        reportDocumentEmbeddingsResponse: reportDocumentEmbeddingsResponseMock,
        reportQueryEmbeddingResponse: reportQueryEmbeddingResponseMock,
        reportStatus: reportStatusMock,
        reportWebgpuAdapterResponse: reportWebgpuAdapterResponseMock,
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
  disposeQueryEmbeddingServiceMock,
  documentEmbeddingsCancelListenerRef,
  documentEmbeddingsListenerRef,
  embeddingCacheRepository,
  embeddingQueueBootstrapMock,
  ensureVectorPreferencesHydratedMock,
  generateDocumentEmbeddingsMock,
  generateQueryEmbeddingMock,
  getEmbeddingQueueMock,
  hostWindow,
  initializeMock,
  initializeWithModelMock,
  queryEmbeddingListenerRef,
  reportDocumentEmbeddingsResponseMock,
  reportQueryEmbeddingResponseMock,
  reportStatusMock,
  reportWebgpuAdapterResponseMock,
  retireEmbeddingQueueMock,
  setDetectedDevicePrefMock,
  startEmbeddingWorkerMock,
  stopMock,
  storeState,
  webgpuAdapterListenerRef,
};
