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

/**
 * Renderer → main IPC is a privilege-escalation boundary. Structured-clone
 * will faithfully forward anything the renderer hands us — including stray
 * fields or prototype-polluted shapes. Pick only the fields we document,
 * ignoring the rest, so a compromised or mismatched renderer can't sneak
 * extra state into the local-runtime services.
 *
 * WARNING: `pickObject` does NOT strip `__proto__` or other prototype-
 * pollution keys — it returns the raw object. The caller-side normalisers
 * (`normaliseProbeOptions` et al.) MUST pick fields explicitly via
 * bracket-notation lookups and MUST NOT `Object.assign` / spread the raw
 * result. The `picks only whitelisted fields` regression test pins this.
 */
function pickObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Expected an options object, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function normaliseEndpointConfig(
  value: unknown
): { apiToken?: string; baseUrl?: string } | undefined {
  const raw = pickObject(value);
  if (!raw) {
    return;
  }
  const endpoint: { apiToken?: string; baseUrl?: string } = {};
  if (typeof raw['baseUrl'] === 'string') {
    endpoint.baseUrl = raw['baseUrl'];
  }
  if (typeof raw['apiToken'] === 'string') {
    endpoint.apiToken = raw['apiToken'];
  }
  return endpoint;
}

function normaliseProbeOptions(value: unknown): SerializableProbeOptions {
  const raw = pickObject(value);
  if (!raw) {
    return {};
  }
  const result: { endpoint?: { apiToken?: string; baseUrl?: string }; force?: boolean } = {};
  if (typeof raw['force'] === 'boolean') {
    result.force = raw['force'];
  }
  const endpoint = normaliseEndpointConfig(raw['endpoint']);
  if (endpoint) {
    result.endpoint = endpoint;
  }
  return result;
}

function normaliseListOptions(value: unknown): SerializableListOptions {
  const raw = pickObject(value);
  if (!raw) {
    return {};
  }
  const result: {
    endpoint?: { apiToken?: string; baseUrl?: string };
    force?: boolean;
    maxVerificationModels?: number;
    verifyEmbeddingDimensions?: boolean;
  } = {};
  if (typeof raw['force'] === 'boolean') {
    result.force = raw['force'];
  }
  if (typeof raw['verifyEmbeddingDimensions'] === 'boolean') {
    result.verifyEmbeddingDimensions = raw['verifyEmbeddingDimensions'];
  }
  if (typeof raw['maxVerificationModels'] === 'number') {
    result.maxVerificationModels = raw['maxVerificationModels'];
  }
  const endpoint = normaliseEndpointConfig(raw['endpoint']);
  if (endpoint) {
    result.endpoint = endpoint;
  }
  return result;
}

function normaliseVerifyOptions(value: unknown): SerializableVerifyOptions {
  const raw = pickObject(value);
  if (!raw) {
    return {};
  }
  const result: { endpoint?: { apiToken?: string; baseUrl?: string }; probeText?: string } = {};
  if (typeof raw['probeText'] === 'string') {
    result.probeText = raw['probeText'];
  }
  const endpoint = normaliseEndpointConfig(raw['endpoint']);
  if (endpoint) {
    result.endpoint = endpoint;
  }
  return result;
}

export function registerRuntimeIpcHandlers(): void {
  ipcMain.handle(
    RUNTIME_PROBE_CHANNEL,
    async (_event: IpcMainInvokeEvent, runtimeId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (runtimeId !== 'ollama' && runtimeId !== 'lmstudio') {
        throw new Error(`Unsupported runtime id: ${String(runtimeId)}`);
      }
      return await bridge.probe(runtimeId, normaliseProbeOptions(rawOptions));
    }
  );

  ipcMain.handle(
    RUNTIME_LIST_MODELS_CHANNEL,
    async (_event: IpcMainInvokeEvent, runtimeId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (runtimeId !== 'ollama' && runtimeId !== 'lmstudio') {
        throw new Error(`Unsupported runtime id: ${String(runtimeId)}`);
      }
      return await bridge.listModels(runtimeId, normaliseListOptions(rawOptions));
    }
  );

  ipcMain.handle(
    RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL,
    async (_event: IpcMainInvokeEvent, modelId: unknown, rawOptions: unknown) => {
      const bridge = getBridge();
      if (typeof modelId !== 'string') {
        throw new Error('modelId must be a string');
      }
      return await bridge.resolveOllamaCapabilities(modelId, normaliseProbeOptions(rawOptions));
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
      return await bridge.verifyEmbeddingDimensions(
        runtimeId,
        modelId,
        normaliseVerifyOptions(rawOptions)
      );
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
