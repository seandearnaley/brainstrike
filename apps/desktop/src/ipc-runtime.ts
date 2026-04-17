import { LocalRuntimeDiscoveryService, LocalRuntimeModelCatalogService } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';

const logger = createLogger('DesktopIpcRuntime');

/**
 * Main-process bridge for local-runtime probes. The renderer's Chromium
 * enforces CORS on fetches to `http://127.0.0.1:11434` (Ollama) and
 * `http://127.0.0.1:1234` (LM Studio) — Ollama's default OLLAMA_ORIGINS
 * allow-list covers `127.0.0.1` / `localhost` but not an Electron renderer
 * origin (`file://`, `app://`, or a dev Vite URL), which produces an opaque
 * `TypeError: Failed to fetch` in the renderer and hides a perfectly
 * reachable daemon.
 *
 * Running the probe in the main process sidesteps this entirely: Node's
 * fetch is not bound by browser CORS and the diagnostic path (logger +
 * cached state) matches the renderer-side services.
 */

export const RUNTIME_PROBE_CHANNEL = 'runtime:probe';
export const RUNTIME_LIST_MODELS_CHANNEL = 'runtime:listModels';
export const RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL = 'runtime:resolveOllamaCapabilities';
export const RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL = 'runtime:verifyEmbeddingDimensions';

interface LocalRuntimeIpcBridge {
  readonly listModels: LocalRuntimeModelCatalogService['listRuntimeModels'];
  readonly probe: LocalRuntimeDiscoveryService['probeRuntime'];
  readonly resolveOllamaCapabilities: LocalRuntimeModelCatalogService['resolveOllamaCapabilities'];
  readonly verifyEmbeddingDimensions: LocalRuntimeModelCatalogService['verifyEmbeddingDimensions'];
}

let cachedBridge: LocalRuntimeIpcBridge | null = null;

function getBridge(): LocalRuntimeIpcBridge {
  if (cachedBridge) {
    return cachedBridge;
  }
  // Node fetch is always available in Electron's main process on the
  // supported Node versions, so there's no fallback needed. The services
  // are lazy-built on first probe to keep app-ready startup snappy.
  const discoveryService = new LocalRuntimeDiscoveryService({
    fetchImpl: globalThis.fetch,
    defaultSurface: 'desktop',
    logger,
  });
  const modelCatalogService = new LocalRuntimeModelCatalogService({
    discoveryService,
    fetchImpl: globalThis.fetch,
    defaultSurface: 'desktop',
    logger,
  });

  cachedBridge = {
    probe: discoveryService.probeRuntime.bind(discoveryService),
    listModels: modelCatalogService.listRuntimeModels.bind(modelCatalogService),
    resolveOllamaCapabilities:
      modelCatalogService.resolveOllamaCapabilities.bind(modelCatalogService),
    verifyEmbeddingDimensions:
      modelCatalogService.verifyEmbeddingDimensions.bind(modelCatalogService),
  };
  return cachedBridge;
}

// Narrow, structural contract for the payload the renderer sends over IPC.
// Keeping this local avoids importing the agent types into `main` (they
// still flow through the bridge at runtime) while matching the service
// option shape exactly.
interface SerializableProbeOptions {
  readonly endpoint?: { readonly apiToken?: string; readonly baseUrl?: string };
  readonly force?: boolean;
}

interface SerializableListOptions extends SerializableProbeOptions {
  readonly maxVerificationModels?: number;
  readonly verifyEmbeddingDimensions?: boolean;
}

interface SerializableVerifyOptions {
  readonly endpoint?: { readonly apiToken?: string; readonly baseUrl?: string };
  readonly probeText?: string;
}

function normaliseOptions<T extends object>(value: unknown): T | undefined {
  if (value === undefined || value === null) {
    return;
  }
  // IPC structured-clone preserves plain objects; reject anything else to
  // fail loudly instead of letting a stray Error bubble in as options.
  if (typeof value !== 'object') {
    throw new Error(`Expected an options object, received ${typeof value}`);
  }
  return value as T;
}

export function registerRuntimeIpcHandlers(): void {
  ipcMain.handle(
    RUNTIME_PROBE_CHANNEL,
    async (_event: IpcMainInvokeEvent, runtimeId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (runtimeId !== 'ollama' && runtimeId !== 'lmstudio') {
        throw new Error(`Unsupported runtime id: ${String(runtimeId)}`);
      }
      const options = normaliseOptions<SerializableProbeOptions>(rawOptions) ?? {};
      return await bridge.probe(runtimeId, options);
    }
  );

  ipcMain.handle(
    RUNTIME_LIST_MODELS_CHANNEL,
    async (_event: IpcMainInvokeEvent, runtimeId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (runtimeId !== 'ollama' && runtimeId !== 'lmstudio') {
        throw new Error(`Unsupported runtime id: ${String(runtimeId)}`);
      }
      const options = normaliseOptions<SerializableListOptions>(rawOptions) ?? {};
      return await bridge.listModels(runtimeId, options);
    }
  );

  ipcMain.handle(
    RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL,
    async (_event: IpcMainInvokeEvent, modelId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (typeof modelId !== 'string') {
        throw new Error('modelId must be a string');
      }
      const options = normaliseOptions<SerializableProbeOptions>(rawOptions) ?? {};
      return await bridge.resolveOllamaCapabilities(modelId, options);
    }
  );

  ipcMain.handle(
    RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL,
    async (
      _event: IpcMainInvokeEvent,
      runtimeId: unknown,
      modelId: unknown,
      rawOptions: unknown
    ) => {
      const bridge = getBridge();
      if (runtimeId !== 'ollama' && runtimeId !== 'lmstudio') {
        throw new Error(`Unsupported runtime id: ${String(runtimeId)}`);
      }
      if (typeof modelId !== 'string') {
        throw new Error('modelId must be a string');
      }
      const options = normaliseOptions<SerializableVerifyOptions>(rawOptions) ?? {};
      return await bridge.verifyEmbeddingDimensions(runtimeId, modelId, options);
    }
  );
}

/**
 * Test-only reset: drops the cached service instances so the next call
 * rebuilds from scratch with fresh fetch bindings. Intentionally not part
 * of the exported surface used by `main.ts`.
 */
export function __resetRuntimeIpcBridgeForTests(): void {
  cachedBridge = null;
}
