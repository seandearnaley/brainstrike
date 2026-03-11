/**
 * Minimal token counting helpers for worker use (no pino/logger dependency).
 * Mirrors the logic of @brainstrike/utils token-utils but without the logger.
 *
 * NOTE: This file is intentionally duplicated in @brainstrike/chunking-worker.
 *
 * Why duplication instead of a shared package:
 * 1. Build isolation - Each worker package uses tsup with `noExternal: ['tiktoken']`
 *    and `loader: { '.wasm': 'dataurl' }` to inline the WASM. Extracting to a shared
 *    package would complicate this bundling behavior.
 * 2. Self-contained workers - The "lite" version exists specifically to have zero
 *    external runtime dependencies (no pino logger). A shared package adds complexity.
 * 3. Electron compatibility - The dataurl approach for WASM is critical for file://
 *    protocol support in Electron. Each worker controls its own bundling.
 *
 * If you modify this file, also update:
 * - packages/chunking-worker/src/token-utils-lite.ts (identical copy)
 * - packages/utils/src/token-utils.ts (similar logic, different logger)
 */

type EncodeFn = (text: string) => Uint32Array;

const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_ENCODING = 'o200k_base';

type EncoderFactory = (input: string) => { encode: EncodeFn };
type BrowserInitFn = (
  callback: (
    imports: WebAssembly.Imports
  ) => Promise<WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource>
) => Promise<void>;
type BrowserEncoderCtor = new (
  bpeRanks: string,
  specialTokens: Record<string, number>,
  patStr: string
) => { encode: EncodeFn };

let nodeEncoderPromise: Promise<EncodeFn | null> | null = null;
let browserEncoderPromise: Promise<EncodeFn | null> | null = null;
let loadFailureLogged = false;
let lastEncoderFailureReason: string | null = null;
const NODE_TIKTOKEN_SPECIFIER = 'tiktoken';

/**
 * IMPORTANT:
 * Electron module workers can report `importScripts` as unavailable.
 * Do NOT use importScripts-based worker detection here, or runtime will
 * misclassify workers as "node" and break accurate tokenizer initialization.
 */
const isWorkerGlobalRuntime = () =>
  typeof self === 'object' &&
  self !== null &&
  typeof (self as { postMessage?: unknown }).postMessage === 'function' &&
  typeof window === 'undefined';

const isBrowserLike = () => typeof window !== 'undefined' || isWorkerGlobalRuntime();

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function tryCreateEncoder(factory: EncoderFactory | undefined, input: string): EncodeFn | null {
  if (!factory) {
    return null;
  }
  try {
    const encoder = factory(input);
    return (text: string) => encoder.encode(text);
  } catch {
    return null;
  }
}

function logOnce(message: string, error: unknown) {
  const normalizedError = normalizeErrorMessage(error);
  lastEncoderFailureReason = `${message}: ${normalizedError}`;
  if (loadFailureLogged) {
    return;
  }
  loadFailureLogged = true;
  // biome-ignore lint/suspicious/noConsole: diagnostic path only
  console.warn('[token-utils-lite]', message, error);
}

export function getAccurateTokenCountingFailureReason(): string | null {
  return lastEncoderFailureReason;
}

function createNodeEncoder(mod: Record<string, unknown>): EncodeFn | null {
  const encodingForModel = mod['encoding_for_model'] as EncoderFactory | undefined;
  const getEncoding = mod['get_encoding'] as EncoderFactory | undefined;
  const modelEncoder = tryCreateEncoder(encodingForModel, DEFAULT_MODEL);
  if (modelEncoder) {
    return modelEncoder;
  }

  const fallbackEncoder = tryCreateEncoder(getEncoding, DEFAULT_ENCODING);
  if (fallbackEncoder) {
    return fallbackEncoder;
  }

  // Preserve a precise reason instead of returning null silently.
  // This keeps terminal worker failures actionable in logs/telemetry.
  const reasons: string[] = [];
  if (encodingForModel) {
    reasons.push(`encoding_for_model(${DEFAULT_MODEL}) failed`);
  } else {
    reasons.push('encoding_for_model export missing');
  }
  if (getEncoding) {
    reasons.push(`get_encoding(${DEFAULT_ENCODING}) failed`);
  } else {
    reasons.push('get_encoding export missing');
  }
  lastEncoderFailureReason = `Node tiktoken encoder unavailable: ${reasons.join('; ')}`;
  return null;
}

async function instantiateBrowserEncoder(): Promise<EncodeFn | null> {
  const [initModuleRaw, wasmUrlModule, encoderModuleRaw] = await Promise.all([
    import('tiktoken/lite/init') as Promise<Record<string, unknown>>,
    import('tiktoken/lite/tiktoken_bg.wasm?url') as Promise<Record<string, unknown>>,
    import('tiktoken/encoders/o200k_base.json') as Promise<Record<string, unknown>>,
  ]);

  const initFn = extractInitFunction(initModuleRaw);
  const encoderCtor = extractEncoderCtor(initModuleRaw);
  const wasmBinary = await fetchWasmBinary(wasmUrlModule);
  const encoderConfig = extractEncoderConfig(encoderModuleRaw);

  if (!(initFn && encoderCtor && encoderConfig)) {
    throw new Error('tiktoken lite modules missing expected exports');
  }

  await initFn((imports) => WebAssembly.instantiate(wasmBinary, imports));

  const encoder = new encoderCtor(
    encoderConfig.bpeRanks,
    encoderConfig.specialTokens,
    encoderConfig.patStr
  );
  return (text: string) => encoder.encode(text);
}

function extractInitFunction(module: Record<string, unknown>): BrowserInitFn | null {
  const candidate = module['init'];
  return typeof candidate === 'function' ? (candidate as BrowserInitFn) : null;
}

function extractEncoderCtor(module: Record<string, unknown>): BrowserEncoderCtor | null {
  const candidate = module['Tiktoken'];
  return typeof candidate === 'function' ? (candidate as BrowserEncoderCtor) : null;
}

async function fetchWasmBinary(module: Record<string, unknown>): Promise<ArrayBuffer> {
  const rawWasmUrl = module['default'];
  if (typeof rawWasmUrl !== 'string') {
    throw new Error('tiktoken wasm asset not resolved as URL');
  }

  // tsup inlines worker WASM as data URLs. Decode directly instead of fetch()
  // to avoid CSP/connect-src restrictions and runtime fetch variability.
  if (rawWasmUrl.startsWith('data:')) {
    return decodeDataUrlToArrayBuffer(rawWasmUrl);
  }

  // Strip the `?url` suffix that tsup incorrectly preserves when bundling Vite-style wasm imports.
  // The `?url` import hint is meant for Vite, but tsup's file loader includes it in the output path.
  const strippedUrl = rawWasmUrl.replace(/\?url$/, '');

  // Resolve the wasm URL relative to the current module's location.
  // In a web worker bundled by tsup, the wasm file is output alongside the worker JS,
  // so we need to resolve the relative path against the module URL (not the page URL).
  const wasmUrl = resolveWasmUrl(strippedUrl);

  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available in this environment');
  }

  const response = await fetchFn(wasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch tiktoken wasm asset: ${response.status} from ${wasmUrl}`);
  }
  return response.arrayBuffer();
}

function decodeDataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex <= 0) {
    throw new Error('Invalid data URL for tiktoken wasm asset');
  }

  const metadata = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const isBase64 = /;base64$/i.test(metadata);

  if (!isBase64) {
    return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
  }

  if (typeof atob === 'function') {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  const bufferGlobal = (globalThis as Record<string, unknown>)['Buffer'];
  if (
    !(
      bufferGlobal &&
      typeof bufferGlobal === 'object' &&
      'from' in bufferGlobal &&
      typeof (bufferGlobal as { from?: unknown }).from === 'function'
    )
  ) {
    throw new Error('No base64 decoder available for wasm data URL');
  }

  const decoded = (bufferGlobal as { from: (value: string, encoding: string) => Uint8Array }).from(
    payload,
    'base64'
  );
  // Copy into a fresh Uint8Array so return type is always ArrayBuffer (not SharedArrayBuffer).
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}

/**
 * Resolve a relative wasm URL to an absolute URL.
 * Handles various runtime contexts: web worker, browser ESM, Vite dev, Electron.
 */
function resolveWasmUrl(relativeUrl: string): string {
  // If already absolute or a data URL, return as-is
  if (
    relativeUrl.startsWith('http://') ||
    relativeUrl.startsWith('https://') ||
    relativeUrl.startsWith('file://') ||
    relativeUrl.startsWith('data:')
  ) {
    return relativeUrl;
  }

  // Try to resolve using import.meta.url (works in ESM contexts including bundled workers)
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL(relativeUrl, import.meta.url).href;
  }

  // Fallback: use self.location in worker context
  if (
    typeof self !== 'undefined' &&
    'location' in self &&
    typeof self.location?.href === 'string'
  ) {
    return new URL(relativeUrl, self.location.href).href;
  }

  // Last resort: return relative URL and let fetch handle it
  return relativeUrl;
}

function extractEncoderConfig(module: Record<string, unknown>): {
  bpeRanks: string;
  specialTokens: Record<string, number>;
  patStr: string;
} | null {
  const payload = module['default'] as Record<string, unknown> | undefined;
  if (!payload) {
    return null;
  }

  const bpeRanks = payload['bpe_ranks'];
  const specialTokens = payload['special_tokens'];
  const patStr = payload['pat_str'];

  if (typeof bpeRanks !== 'string' || typeof patStr !== 'string') {
    return null;
  }

  if (typeof specialTokens !== 'object' || specialTokens === null) {
    return null;
  }

  return {
    bpeRanks,
    specialTokens: specialTokens as Record<string, number>,
    patStr,
  };
}

async function loadNodeEncoder(): Promise<EncodeFn | null> {
  if (!nodeEncoderPromise) {
    nodeEncoderPromise = (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ NODE_TIKTOKEN_SPECIFIER)) as Record<
          string,
          unknown
        >;
        return createNodeEncoder(mod);
      } catch (error) {
        logOnce('Failed to load tiktoken (node)', error);
        return null;
      }
    })();
  }
  return nodeEncoderPromise;
}

async function loadBrowserEncoder(): Promise<EncodeFn | null> {
  if (!browserEncoderPromise) {
    browserEncoderPromise = (async () => {
      try {
        return await instantiateBrowserEncoder();
      } catch (error) {
        logOnce('Failed to load tiktoken (browser)', error);
        return null;
      }
    })();
  }
  return browserEncoderPromise;
}

async function resolveEncoder(): Promise<EncodeFn | null> {
  return isBrowserLike() ? loadBrowserEncoder() : loadNodeEncoder();
}

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  const encoder = await resolveEncoder();
  return encoder !== null;
}

export async function countTokensAccurate(text: string): Promise<number> {
  if (!text) {
    return 0;
  }
  const encoder = await resolveEncoder();
  if (!encoder) {
    const failureReason = getAccurateTokenCountingFailureReason();
    const failureSuffix = failureReason ? ` (${failureReason})` : '';
    throw new Error(
      `Accurate token counting unavailable: tiktoken encoder failed to initialize${failureSuffix}`
    );
  }

  try {
    return encoder(text).length;
  } catch (error) {
    logOnce('tiktoken encode failed', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Accurate token counting failed: ${message}`);
  }
}

export function countTokensHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  // Simple heuristic: ~4 chars per token
  return Math.max(1, Math.ceil(text.length / 4));
}
