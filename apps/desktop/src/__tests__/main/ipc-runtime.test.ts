/**
 * Regression tests for the main-process runtime-probe IPC bridge. This bridge
 * exists because Chromium in the renderer enforces CORS on fetches to
 * `http://127.0.0.1:11434` (Ollama) and `http://127.0.0.1:1234` (LM Studio);
 * the main process has no such restriction, so probes run here instead.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// vi.mock is hoisted to the top of the file, so the mocks it references must
// live inside vi.hoisted. Class-based stubs (rather than vi.fn-as-constructor)
// give us reliable `new`-ability across vitest versions.
const {
  probeRuntimeMock,
  listRuntimeModelsMock,
  resolveOllamaCapabilitiesMock,
  verifyEmbeddingDimensionsMock,
} = vi.hoisted(() => ({
  probeRuntimeMock: vi.fn().mockResolvedValue({
    state: 'available',
    checkedAt: 100,
    endpoint: 'http://127.0.0.1:11434/api/tags',
    latencyMs: 2,
  }),
  listRuntimeModelsMock: vi.fn().mockResolvedValue({
    state: 'loaded_non_empty',
    runtime: 'ollama',
    models: [],
  }),
  resolveOllamaCapabilitiesMock: vi.fn().mockResolvedValue({
    state: 'resolved',
    modelId: 'qwen3:latest',
    capabilities: ['completion'],
  }),
  verifyEmbeddingDimensionsMock: vi.fn().mockResolvedValue({
    state: 'verified',
    dimensions: 768,
  }),
}));

vi.mock('@brainstrike/agent', () => {
  class StubLocalRuntimeDiscoveryService {
    probeRuntime = probeRuntimeMock;
  }
  class StubLocalRuntimeModelCatalogService {
    listRuntimeModels = listRuntimeModelsMock;
    resolveOllamaCapabilities = resolveOllamaCapabilitiesMock;
    verifyEmbeddingDimensions = verifyEmbeddingDimensionsMock;
  }
  return {
    LocalRuntimeDiscoveryService: StubLocalRuntimeDiscoveryService,
    LocalRuntimeModelCatalogService: StubLocalRuntimeModelCatalogService,
  };
});

import { ipcMain } from 'electron';
import {
  __resetRuntimeIpcBridgeForTests,
  RUNTIME_LIST_MODELS_CHANNEL,
  RUNTIME_PROBE_CHANNEL,
  RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL,
  RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL,
  registerRuntimeIpcHandlers,
} from '../../ipc-runtime';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getRegisteredHandler(channel: string): Handler {
  const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
  const call = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!call) {
    throw new Error(`No IPC handler registered for channel ${channel}`);
  }
  return call[1] as Handler;
}

describe('ipc-runtime main-process probe bridge', () => {
  beforeEach(() => {
    (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear();
    probeRuntimeMock.mockClear();
    listRuntimeModelsMock.mockClear();
    resolveOllamaCapabilitiesMock.mockClear();
    verifyEmbeddingDimensionsMock.mockClear();
    __resetRuntimeIpcBridgeForTests();
    registerRuntimeIpcHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers channels through the typed desktop IPC registry', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/ipc-runtime.ts'), 'utf8');

    expect(source).toContain('createDesktopIpcRegistry');
    expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
    expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
  });

  it('registers handlers on the documented IPC channels', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith(RUNTIME_PROBE_CHANNEL, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(RUNTIME_LIST_MODELS_CHANNEL, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(
      RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL,
      expect.any(Function)
    );
  });

  it('forwards probe calls to the discovery service and returns its result', async () => {
    const handler = getRegisteredHandler(RUNTIME_PROBE_CHANNEL);

    const result = await handler({} as IpcMainInvokeEvent, 'ollama', {
      diagnosticLogLevel: 'debug',
      force: true,
      endpoint: { baseUrl: 'http://gpu.lan:11434' },
    });

    expect(probeRuntimeMock).toHaveBeenCalledWith('ollama', {
      diagnosticLogLevel: 'debug',
      force: true,
      endpoint: { baseUrl: 'http://gpu.lan:11434' },
    });
    expect(result).toMatchObject({ state: 'available' });
  });

  it('rejects unsupported runtime ids with a clear error', async () => {
    const handler = getRegisteredHandler(RUNTIME_PROBE_CHANNEL);

    await expect(handler({} as IpcMainInvokeEvent, 'not-a-runtime', undefined)).rejects.toThrow(
      /Unsupported runtime id/
    );
  });

  it('forwards listModels calls and returns the catalog state', async () => {
    const handler = getRegisteredHandler(RUNTIME_LIST_MODELS_CHANNEL);

    const result = await handler({} as IpcMainInvokeEvent, 'lmstudio', {
      diagnosticLogLevel: 'debug',
      verifyEmbeddingDimensions: true,
    });

    expect(listRuntimeModelsMock).toHaveBeenCalledWith('lmstudio', {
      diagnosticLogLevel: 'debug',
      verifyEmbeddingDimensions: true,
    });
    expect(result).toMatchObject({ state: 'loaded_non_empty' });
  });

  it('forwards resolveOllamaCapabilities with the model id', async () => {
    const handler = getRegisteredHandler(RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL);

    const result = await handler({} as IpcMainInvokeEvent, 'qwen3:latest', {});

    expect(resolveOllamaCapabilitiesMock).toHaveBeenCalledWith('qwen3:latest', {});
    expect(result).toMatchObject({ state: 'resolved' });
  });

  it('rejects non-string modelIds for resolveOllamaCapabilities', async () => {
    const handler = getRegisteredHandler(RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL);

    await expect(handler({} as IpcMainInvokeEvent, 42, undefined)).rejects.toThrow(
      /modelId must be a string/
    );
  });

  it('scrubs prototype-pollution keys from the object returned by pickObject', async () => {
    // Reviewer feedback: pickObject returned the raw object cast to
    // Record<string, unknown>. If a future normaliser ever spreads or
    // Object.assigns the raw result, an attacker-controlled __proto__
    // could poison Object.prototype. Contract: the returned object must
    // NOT inherit from Object.prototype (or equivalently, its prototype
    // chain must not carry pollution keys). Safe-by-construction beats
    // safe-by-contract.
    const handler = getRegisteredHandler(RUNTIME_PROBE_CHANNEL);

    const poisoned = JSON.parse(
      '{"force": true, "__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted2": "yes"}}}'
    );

    await handler({} as IpcMainInvokeEvent, 'ollama', poisoned);

    // eslint-disable-next-line no-proto
    const baseObject: Record<string, unknown> = {};
    expect((baseObject as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((baseObject as Record<string, unknown>)['polluted2']).toBeUndefined();

    const [, forwardedOptions] = probeRuntimeMock.mock.calls[0] ?? [];
    // The normaliser already picks explicitly so `__proto__` can't ride,
    // but the pick-from-prototype-less object is the safe-by-construction
    // belt-and-braces we want to land.
    expect(
      Object.getPrototypeOf(forwardedOptions) === Object.prototype ||
        Object.getPrototypeOf(forwardedOptions) === null
    ).toBe(true);
  });

  it('only forwards whitelisted option fields across the IPC trust boundary', async () => {
    // Reviewer feedback: renderer → main IPC is a trust boundary. The old
    // normaliser passed the raw object through after a `typeof === 'object'`
    // check, so extra fields injected by a compromised renderer (or by a
    // future version mismatch) would ride along into the service call.
    // Contract: the forwarded options must contain ONLY the documented
    // { force, endpoint: { apiToken, baseUrl } } fields.
    const handler = getRegisteredHandler(RUNTIME_PROBE_CHANNEL);

    await handler({} as IpcMainInvokeEvent, 'ollama', {
      diagnosticLogLevel: 'warn',
      force: true,
      endpoint: {
        baseUrl: 'http://safe.lan:11434',
        apiToken: 'tok',
        __proto__: { evil: true },
        extraField: 'should be dropped',
      },
      signal: 'not-a-real-abort-signal',
      injectedAction: () => 'boom',
    });

    const [, forwardedOptions] = probeRuntimeMock.mock.calls[0] ?? [];
    expect(forwardedOptions).toEqual({
      diagnosticLogLevel: 'warn',
      force: true,
      endpoint: {
        baseUrl: 'http://safe.lan:11434',
        apiToken: 'tok',
      },
    });
  });
});
