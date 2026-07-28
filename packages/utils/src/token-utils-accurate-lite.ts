import { ACCURATE_TOKEN_ENCODING, ACCURATE_TOKEN_MODEL_HINT } from './token-constants';

type EncodeFn = (text: string) => Uint32Array;

const DEFAULT_MODEL = ACCURATE_TOKEN_MODEL_HINT;
const DEFAULT_ENCODING = ACCURATE_TOKEN_ENCODING;
const NODE_TIKTOKEN_SPECIFIER = 'tiktoken';

// tiktoken's wasm-bindgen encoder exposes both `encode` (special-token aware)
// and `encode_ordinary` (plain text). We only use `encode_ordinary` for
// arbitrary content tokenization; `encode` exists in the interface because
// some encoder factories surface it but it's not required by this module.
interface EncoderInstance {
  encode?: EncodeFn;
  // biome-ignore lint/style/useNamingConvention: tiktoken wasm-bindgen API
  encode_ordinary: EncodeFn;
  free?: () => void;
}

interface ResolvedEncoder {
  dispose?: () => void;
  encodeContent: EncodeFn;
}

interface EncoderLoadPolicy {
  failedAttempts: number;
  lastFailureReason: string | null;
  retryAfterMs: number;
}

type EncoderFactory = (input: string) => EncoderInstance;
type BrowserInitFn = (
  callback: (
    imports: WebAssembly.Imports
  ) => Promise<WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource>
) => Promise<void>;
type BrowserEncoderCtor = new (
  bpeRanks: string,
  specialTokens: Record<string, number>,
  patStr: string
) => EncoderInstance;

const ENCODER_LOAD_MAX_ATTEMPTS = 3;
const ENCODER_LOAD_RETRY_BASE_MS = 1000;
const ENCODER_LOAD_RETRY_COOLDOWN_MS = 60_000;
const DISPOSED_DURING_ENCODER_LOAD = Symbol('disposed-during-encoder-load');
type EncoderResolution = ResolvedEncoder | null | typeof DISPOSED_DURING_ENCODER_LOAD;

let nodeEncoderPromise: Promise<EncoderResolution> | null = null;
let browserEncoderPromise: Promise<EncoderResolution> | null = null;
let nodeLoadPolicy: EncoderLoadPolicy = createEncoderLoadPolicy();
let browserLoadPolicy: EncoderLoadPolicy = createEncoderLoadPolicy();
let runtimeGeneration = 0;
let loadFailureLogged = false;
let lastEncoderFailureReason: string | null = null;

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

function createEncoderLoadPolicy(): EncoderLoadPolicy {
  return {
    failedAttempts: 0,
    lastFailureReason: null,
    retryAfterMs: 0,
  };
}

function withLastFailure(reason: string, policy: EncoderLoadPolicy): string {
  return policy.lastFailureReason ? `${reason}; last failure: ${policy.lastFailureReason}` : reason;
}

function monotonicNowMs(): number {
  return globalThis.performance.now();
}

function getRetryBlockReason(
  runtime: 'browser' | 'node',
  policy: EncoderLoadPolicy
): string | null {
  const remainingBackoffMs = Math.ceil(policy.retryAfterMs - monotonicNowMs());
  if (policy.failedAttempts >= ENCODER_LOAD_MAX_ATTEMPTS) {
    if (remainingBackoffMs <= 0) {
      policy.failedAttempts = 0;
      policy.retryAfterMs = 0;
      return null;
    }

    return withLastFailure(
      `${runtime} tiktoken retry limit reached after ${ENCODER_LOAD_MAX_ATTEMPTS} failed attempts; retry budget reopens in ${remainingBackoffMs}ms`,
      policy
    );
  }

  if (remainingBackoffMs > 0) {
    return withLastFailure(
      `${runtime} tiktoken retry backoff active for ${remainingBackoffMs}ms after attempt ${policy.failedAttempts}`,
      policy
    );
  }
  return null;
}

function recordLoadFailure(runtime: 'browser' | 'node', policy: EncoderLoadPolicy): void {
  policy.lastFailureReason = lastEncoderFailureReason;
  policy.failedAttempts += 1;
  if (policy.failedAttempts >= ENCODER_LOAD_MAX_ATTEMPTS) {
    policy.retryAfterMs = monotonicNowMs() + ENCODER_LOAD_RETRY_COOLDOWN_MS;
    lastEncoderFailureReason = withLastFailure(
      `${runtime} tiktoken retry limit reached after ${ENCODER_LOAD_MAX_ATTEMPTS} failed attempts; retry budget reopens after ${ENCODER_LOAD_RETRY_COOLDOWN_MS}ms`,
      policy
    );
    return;
  }

  const retryDelayMs = ENCODER_LOAD_RETRY_BASE_MS * 2 ** Math.max(0, policy.failedAttempts - 1);
  policy.retryAfterMs = monotonicNowMs() + retryDelayMs;
}

function clearLoadFailure(policy: EncoderLoadPolicy): void {
  policy.failedAttempts = 0;
  policy.lastFailureReason = null;
  policy.retryAfterMs = 0;
  loadFailureLogged = false;
  lastEncoderFailureReason = null;
}

function toResolvedEncoder(encoder: EncoderInstance): ResolvedEncoder {
  if (typeof encoder.encode_ordinary !== 'function') {
    throw new Error('tiktoken encoder missing encode_ordinary');
  }
  const resolvedEncoder: ResolvedEncoder = {
    // File contents must be tokenized as ordinary text. Special-token aware
    // prompt encoding is not valid for arbitrary source files.
    // wasm-bindgen encoder methods require the original instance as `this`.
    encodeContent: (text: string) => encoder.encode_ordinary.call(encoder, text),
  };
  if (typeof encoder.free === 'function') {
    resolvedEncoder.dispose = () => encoder.free?.();
  }
  return resolvedEncoder;
}

function tryCreateEncoder(
  factory: EncoderFactory | undefined,
  input: string
): ResolvedEncoder | null {
  if (!factory) {
    return null;
  }
  try {
    const encoder = factory(input);
    return toResolvedEncoder(encoder);
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
  console.warn('[token-utils-accurate-lite]', message, error);
}

export function getAccurateTokenCountingFailureReason(): string | null {
  return lastEncoderFailureReason;
}

function createNodeEncoder(mod: Record<string, unknown>): ResolvedEncoder | null {
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

async function instantiateBrowserEncoder(): Promise<ResolvedEncoder> {
  const [initModuleRaw, wasmUrlModule, encoderUrlModule] = await Promise.all([
    import('tiktoken/lite/init') as Promise<Record<string, unknown>>,
    import('tiktoken/lite/tiktoken_bg.wasm?url') as Promise<Record<string, unknown>>,
    import('tiktoken/encoders/o200k_base.json?url') as Promise<Record<string, unknown>>,
  ]);

  const initFn = extractInitFunction(initModuleRaw);
  const encoderCtor = extractEncoderCtor(initModuleRaw);
  const [wasmBinary, encoderConfig] = await Promise.all([
    fetchWasmBinary(wasmUrlModule),
    fetchEncoderConfig(encoderUrlModule),
  ]);

  if (!(initFn && encoderCtor && encoderConfig)) {
    throw new Error('tiktoken lite modules missing expected exports');
  }

  await initFn((imports) => WebAssembly.instantiate(wasmBinary, imports));

  const encoder = new encoderCtor(
    encoderConfig.bpeRanks,
    encoderConfig.specialTokens,
    encoderConfig.patStr
  );
  return toResolvedEncoder(encoder);
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

  if (rawWasmUrl.startsWith('data:')) {
    return decodeDataUrlToArrayBuffer(rawWasmUrl);
  }

  const strippedUrl = rawWasmUrl.replace(/\?url$/, '');
  const wasmUrl = resolveRuntimeAssetUrl(strippedUrl);

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
  // Buffer.from() may return a pooled/shared backing buffer, so we must copy into
  // a right-sized Uint8Array instead of returning decoded.buffer directly.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}

function resolveRuntimeAssetUrl(relativeUrl: string): string {
  if (typeof location !== 'undefined' && typeof location.href === 'string') {
    return new URL(relativeUrl, location.href).href;
  }

  if (typeof self === 'object' && self !== null && typeof self.location?.href === 'string') {
    return new URL(relativeUrl, self.location.href).href;
  }

  return relativeUrl;
}

async function fetchEncoderConfig(
  module: Record<string, unknown>
): Promise<ReturnType<typeof extractEncoderConfig>> {
  const rawConfigUrl = module['default'];
  if (typeof rawConfigUrl !== 'string') {
    throw new Error('tiktoken encoder config asset not resolved as URL');
  }

  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available in this environment');
  }

  const configUrl = resolveRuntimeAssetUrl(rawConfigUrl.replace(/\?url$/, ''));
  const response = await fetchFn(configUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tiktoken encoder config: ${response.status} from ${configUrl}`
    );
  }

  return extractEncoderConfig(await response.json());
}

function extractEncoderConfig(payload: unknown): {
  bpeRanks: string;
  specialTokens: Record<string, number>;
  patStr: string;
} | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const config = payload as Record<string, unknown>;
  const bpeRanks = config['bpe_ranks'];
  const specialTokens = config['special_tokens'];
  const patStr = config['pat_str'];

  if (typeof bpeRanks !== 'string' || typeof patStr !== 'string') {
    return null;
  }

  if (typeof specialTokens !== 'object' || specialTokens === null) {
    return null;
  }

  if (!Object.values(specialTokens).every((value) => typeof value === 'number')) {
    return null;
  }

  return {
    bpeRanks,
    patStr,
    specialTokens: specialTokens as Record<string, number>,
  };
}

async function loadNodeEncoder(): Promise<EncoderResolution> {
  if (!nodeEncoderPromise) {
    const retryBlockReason = getRetryBlockReason('node', nodeLoadPolicy);
    if (retryBlockReason) {
      lastEncoderFailureReason = retryBlockReason;
      return null;
    }

    const loadGeneration = runtimeGeneration;
    nodeEncoderPromise = (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ NODE_TIKTOKEN_SPECIFIER)) as Record<
          string,
          unknown
        >;
        const encoder = createNodeEncoder(mod);
        if (loadGeneration !== runtimeGeneration) {
          encoder?.dispose?.();
          return DISPOSED_DURING_ENCODER_LOAD;
        }
        if (!encoder) {
          recordLoadFailure('node', nodeLoadPolicy);
          nodeEncoderPromise = null;
          return null;
        }
        clearLoadFailure(nodeLoadPolicy);
        return encoder;
      } catch (error) {
        if (loadGeneration !== runtimeGeneration) {
          return DISPOSED_DURING_ENCODER_LOAD;
        }
        logOnce('Failed to load tiktoken (node)', error);
        recordLoadFailure('node', nodeLoadPolicy);
        nodeEncoderPromise = null;
        return null;
      }
    })();
  }
  return nodeEncoderPromise;
}

async function loadBrowserEncoder(): Promise<EncoderResolution> {
  if (!browserEncoderPromise) {
    const retryBlockReason = getRetryBlockReason('browser', browserLoadPolicy);
    if (retryBlockReason) {
      lastEncoderFailureReason = retryBlockReason;
      return null;
    }

    const loadGeneration = runtimeGeneration;
    browserEncoderPromise = (async () => {
      try {
        const encoder = await instantiateBrowserEncoder();
        if (loadGeneration !== runtimeGeneration) {
          encoder?.dispose?.();
          return DISPOSED_DURING_ENCODER_LOAD;
        }
        clearLoadFailure(browserLoadPolicy);
        return encoder;
      } catch (error) {
        if (loadGeneration !== runtimeGeneration) {
          return DISPOSED_DURING_ENCODER_LOAD;
        }
        logOnce('Failed to load tiktoken (browser)', error);
        recordLoadFailure('browser', browserLoadPolicy);
        browserEncoderPromise = null;
        return null;
      }
    })();
  }
  return browserEncoderPromise;
}

async function resolveEncoder(): Promise<EncoderResolution> {
  return isBrowserLike() ? loadBrowserEncoder() : loadNodeEncoder();
}

function resetEncoderLoadState(): void {
  nodeEncoderPromise = null;
  browserEncoderPromise = null;
  nodeLoadPolicy = createEncoderLoadPolicy();
  browserLoadPolicy = createEncoderLoadPolicy();
  loadFailureLogged = false;
  lastEncoderFailureReason = null;
}

function disposeResolvedEncoder(promise: Promise<EncoderResolution> | null): void {
  if (!promise) {
    return;
  }
  void promise
    .then((encoder) => {
      if (encoder && encoder !== DISPOSED_DURING_ENCODER_LOAD) {
        encoder.dispose?.();
      }
    })
    .catch(() => {
      // Ignore failed initialization during disposal/reset.
    });
}

export function disposeAccurateTokenCountingRuntime(): void {
  const pendingNodeEncoder = nodeEncoderPromise;
  const pendingBrowserEncoder = browserEncoderPromise;
  runtimeGeneration += 1;
  resetEncoderLoadState();
  disposeResolvedEncoder(pendingNodeEncoder);
  disposeResolvedEncoder(pendingBrowserEncoder);
}

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  const encoder = await resolveEncoder();
  return encoder !== null && encoder !== DISPOSED_DURING_ENCODER_LOAD;
}

export async function countTokensAccurate(text: string): Promise<number> {
  if (!text) {
    return 0;
  }

  const encoder = await resolveEncoder();
  if (encoder === DISPOSED_DURING_ENCODER_LOAD) {
    throw new Error(
      'Accurate token counting unavailable: runtime was disposed during encoder initialization'
    );
  }
  if (!encoder) {
    const failureReason = getAccurateTokenCountingFailureReason();
    const failureSuffix = failureReason ? ` (${failureReason})` : '';
    throw new Error(
      `Accurate token counting unavailable: tiktoken encoder failed to initialize${failureSuffix}`
    );
  }

  try {
    return encoder.encodeContent(text).length;
  } catch (error) {
    logOnce('tiktoken encode failed', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Accurate token counting failed: ${message}`);
  }
}

export type SyncAccurateCounter = (text: string) => number;

/** Resolve the encoder once and return a synchronous counter.
 *  The counter throws deterministically after its runtime is disposed. */
export async function getAccurateTokenCounter(): Promise<SyncAccurateCounter | null> {
  const counterGeneration = runtimeGeneration;
  const encoder = await resolveEncoder();
  if (
    !encoder ||
    encoder === DISPOSED_DURING_ENCODER_LOAD ||
    counterGeneration !== runtimeGeneration
  ) {
    return null;
  }
  return (text: string) => {
    if (counterGeneration !== runtimeGeneration) {
      throw new Error('Accurate token counter is inactive because its runtime was disposed');
    }
    return encoder.encodeContent(text).length;
  };
}
