import {
  LocalRuntimeDiscoveryService,
  LocalRuntimeModelCatalogService,
} from '@brainstrike/local-runtime';
import { createLogger } from '@brainstrike/logging';
import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

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

export const RUNTIME_PROBE_CHANNEL = DESKTOP_IPC_CHANNELS.runtime.probe;
export const RUNTIME_LIST_MODELS_CHANNEL = DESKTOP_IPC_CHANNELS.runtime.listModels;
export const RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL =
  DESKTOP_IPC_CHANNELS.runtime.resolveOllamaCapabilities;
export const RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL =
  DESKTOP_IPC_CHANNELS.runtime.verifyEmbeddingDimensions;

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
  //
  // Bound explicitly. An explicit fetchImpl bypasses the constructors' bound
  // default, and undici tolerates a lost receiver where a browser does not
  // (BST-964) — so an unbound reference here would be a latent trap for anyone
  // who later reuses this wiring in a renderer.
  const discoveryService = new LocalRuntimeDiscoveryService({
    defaultSurface: 'desktop',
    fetchImpl: globalThis.fetch.bind(globalThis),
    logger,
  });
  const modelCatalogService = new LocalRuntimeModelCatalogService({
    defaultSurface: 'desktop',
    discoveryService,
    fetchImpl: globalThis.fetch.bind(globalThis),
    logger,
  });

  cachedBridge = {
    listModels: modelCatalogService.listRuntimeModels.bind(modelCatalogService),
    probe: discoveryService.probeRuntime.bind(discoveryService),
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
  readonly diagnosticLogLevel?: 'debug' | 'warn';
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
 * Renderer → main IPC is a privilege-escalation boundary — a COMPROMISED
 * renderer (XSS, supply-chain attack, rogue preload injection) must not
 * be able to reach the main process's file-system / Node / shell access
 * via this channel. The hardening here is defense-in-depth for that
 * threat model, not just "tidy up accidental extra fields."
 *
 * Structured-clone faithfully forwards anything the renderer hands us,
 * including stray fields or prototype-polluted shapes. Pick only the
 * fields we document, ignoring the rest, so an attacker-controlled
 * payload can't sneak extra state into the local-runtime services.
 *
 * Safe-by-construction: `Object.fromEntries(Object.entries(value))`
 * rebuilds a plain object from own enumerable keys only, stripping any
 * inherited `__proto__` / `constructor` pollution that a future consumer
 * might accidentally spread into state. The per-field normalisers below
 * still pick explicitly as a second line of defense, but this keeps the
 * guarantee intact even if a future refactor violates that contract.
 */
function pickObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Expected an options object, received ${typeof value}`);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>));
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

function normaliseDiagnosticLogLevel(value: unknown): 'debug' | 'warn' | undefined {
  if (value === 'debug' || value === 'warn') {
    return value;
  }
  return;
}

function normaliseProbeOptions(value: unknown): SerializableProbeOptions {
  const raw = pickObject(value);
  if (!raw) {
    return {};
  }
  const result: {
    diagnosticLogLevel?: 'debug' | 'warn';
    endpoint?: { apiToken?: string; baseUrl?: string };
    force?: boolean;
  } = {};
  if (typeof raw['force'] === 'boolean') {
    result.force = raw['force'];
  }
  const diagnosticLogLevel = normaliseDiagnosticLogLevel(raw['diagnosticLogLevel']);
  if (diagnosticLogLevel) {
    result.diagnosticLogLevel = diagnosticLogLevel;
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
    diagnosticLogLevel?: 'debug' | 'warn';
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
  const diagnosticLogLevel = normaliseDiagnosticLogLevel(raw['diagnosticLogLevel']);
  if (diagnosticLogLevel) {
    result.diagnosticLogLevel = diagnosticLogLevel;
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

/**
 * Type guard that narrows an unknown IPC payload to a supported runtime id.
 * Centralising the check so adding a future runtime means touching this
 * function — the handlers automatically pick up the new variant via type
 * narrowing.
 */
function validateRuntimeId(value: unknown): 'ollama' | 'lmstudio' {
  if (value !== 'ollama' && value !== 'lmstudio') {
    throw new Error(`Unsupported runtime id: ${String(value)}`);
  }
  return value;
}

function validateModelId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('modelId must be a string');
  }
  return value;
}

export function registerRuntimeIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'runtime',
    RUNTIME_PROBE_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, runtimeId: unknown, rawOptions: unknown) =>
      await getBridge().probe(validateRuntimeId(runtimeId), normaliseProbeOptions(rawOptions))
  );

  registry.registerUnauthenticatedInvoke(
    'runtime',
    RUNTIME_LIST_MODELS_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, runtimeId: unknown, rawOptions: unknown) =>
      await getBridge().listModels(validateRuntimeId(runtimeId), normaliseListOptions(rawOptions))
  );

  registry.registerUnauthenticatedInvoke(
    'runtime',
    RUNTIME_RESOLVE_OLLAMA_CAPABILITIES_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, modelId: unknown, rawOptions: unknown) =>
      await getBridge().resolveOllamaCapabilities(
        validateModelId(modelId),
        normaliseProbeOptions(rawOptions)
      )
  );

  registry.registerUnauthenticatedInvoke(
    'runtime',
    RUNTIME_VERIFY_EMBEDDING_DIMENSIONS_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, runtimeId: unknown, modelId: unknown, rawOptions: unknown) =>
      await getBridge().verifyEmbeddingDimensions(
        validateRuntimeId(runtimeId),
        validateModelId(modelId),
        normaliseVerifyOptions(rawOptions)
      )
  );

  return () => {
    registry.unregisterAll();
  };
}

/**
 * Test-only reset: drops the cached service instances so the next call
 * rebuilds from scratch with fresh fetch bindings. Intentionally not part
 * of the exported surface used by `main.ts`.
 */
export function __resetRuntimeIpcBridgeForTests(): void {
  cachedBridge = null;
}
