import { resolve } from 'node:path';
import { vi } from 'vitest';

export interface EmbeddingLifecycleStatus {
  active: boolean;
  commandId?: string;
  lastError: string | null;
  runtimeId: string;
  runtimeKind?: 'embedding-host';
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
  webgpuAdapter?: { available: boolean; reason: string };
  webgpuAdapterError?: string;
}

const { currentLifecycleStatus, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const { EventEmitter } = process.getBuiltinModule('node:events');
  const hostWindow = Object.assign(new EventEmitter(), {
    destroy: vi.fn(() => hostWindow.emit('closed')),
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id: 91,
      send: vi.fn(),
    }),
  });
  const currentStatus: EmbeddingLifecycleStatus = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host',
    state: 'running',
  };

  return {
    currentLifecycleStatus: currentStatus,
    lifecycleState: {
      acceptsStatus: vi.fn(() => true),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn<() => Promise<EmbeddingLifecycleStatus>>(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host-runtime',
        state: 'running',
      })),
      getHostWindow: vi.fn<() => typeof hostWindow | null | undefined>(() => hostWindow),
      getStatus: vi.fn<() => EmbeddingLifecycleStatus>(() => ({ ...currentStatus })),
      isHostWindow: vi.fn(() => false),
      joinPhysicalClose: vi.fn(async () => {}),
      restart: vi.fn(async function (this: { ensureStarted(): Promise<unknown> }) {
        return this.ensureStarted();
      }),
      retire: vi.fn(async function (this: { destroyHostWindow(): Promise<void> }) {
        await this.destroyHostWindow();
      }),
      setStatus: vi.fn<(status: EmbeddingLifecycleStatus) => void>((status) => {
        currentStatus.active = status.active;
        currentStatus.lastError = status.lastError;
        currentStatus.runtimeId = status.runtimeId;
        currentStatus.runtimeKind = status.runtimeKind ?? 'embedding-host';
        currentStatus.state = status.state;
      }),
      stop: vi.fn(async function (
        this: { destroyHostWindow(): Promise<void> },
        protocol?: () => Promise<void>
      ) {
        const failures: unknown[] = [];
        try {
          await protocol?.();
        } catch (cause) {
          failures.push(cause);
        }
        try {
          await this.destroyHostWindow();
        } catch (cause) {
          failures.push(cause);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Stop and physical release failed');
        }
      }),
      waitForStatus: vi.fn<
        (
          predicate: (status: EmbeddingLifecycleStatus) => boolean,
          timeoutMs: number
        ) => Promise<EmbeddingLifecycleStatus>
      >(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host-runtime',
        state: 'stopped',
      })),
    },
    mockHostWindow: hostWindow,
  };
});

const { powerSaveBlockerIsStartedMock, powerSaveBlockerStartMock, powerSaveBlockerStopMock } =
  vi.hoisted(() => ({
    powerSaveBlockerIsStartedMock: vi.fn(() => true),
    powerSaveBlockerStartMock: vi.fn(() => 101),
    powerSaveBlockerStopMock: vi.fn(),
  }));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => resolve('/mock/app')),
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  powerSaveBlocker: {
    isStarted: powerSaveBlockerIsStartedMock,
    start: powerSaveBlockerStartMock,
    stop: powerSaveBlockerStopMock,
  },
}));

/** The lifecycle callbacks the latest manager registered, so a test can retire its host. */
const lifecycleCallbacks = vi.hoisted(() => ({
  current: null as { readonly onWindowClosed: () => void } | null,
}));

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle(options: {
    readonly onWindowClosed: () => void;
  }) {
    lifecycleCallbacks.current = options;
    return lifecycleState;
  }),
}));

const hostedEmbeddingMock = vi.hoisted(() => vi.fn());
vi.mock('../hosted-embeddings', () => ({ generateHostedEmbeddings: hostedEmbeddingMock }));

import { EmbeddingHostManager, type EmbeddingHostManagerOptions } from '../embedding-host-manager';

// Load the manager through this fixture so its hoisted Electron/lifecycle mocks
// are registered before the production module binds those dependencies.
function createEmbeddingHostManager(options?: EmbeddingHostManagerOptions): EmbeddingHostManager {
  return new EmbeddingHostManager(options);
}

// Map public keys without private members so tests can expose syncPowerSaveBlocker.
type TestableEmbeddingHostManager = Omit<EmbeddingHostManager, never> & {
  syncPowerSaveBlocker: (status: {
    active: boolean;
    lastError: string | null;
    state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
  }) => void;
};

function createDarwinManager(): TestableEmbeddingHostManager {
  return createEmbeddingHostManager({
    platform: 'darwin',
  }) as unknown as TestableEmbeddingHostManager;
}

export type { TestableEmbeddingHostManager };
export {
  createDarwinManager,
  createEmbeddingHostManager,
  currentLifecycleStatus,
  hostedEmbeddingMock,
  lifecycleCallbacks,
  lifecycleState,
  mockHostWindow,
  powerSaveBlockerIsStartedMock,
  powerSaveBlockerStartMock,
  powerSaveBlockerStopMock,
};
