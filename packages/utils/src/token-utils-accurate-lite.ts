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

let nodeEncoderPromise: Promise<ResolvedEncoder | null> | null = null;
let browserEncoderPromise: Promise<ResolvedEncoder | null> | null = null;
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

async function instantiateBrowserEncoder(): Promise<ResolvedEncoder | null> {
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
  // Buffer.from() may return a pooled/shared backing buffer, so we must copy into
  // a right-sized Uint8Array instead of returning decoded.buffer directly.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}

function resolveWasmUrl(relativeUrl: string): string {
  if (typeof location !== 'undefined' && typeof location.href === 'string') {
    return new URL(relativeUrl, location.href).href;
  }

  if (typeof self === 'object' && self !== null && typeof self.location?.href === 'string') {
    return new URL(relativeUrl, self.location.href).href;
  }

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

  if (!Object.values(specialTokens).every((value) => typeof value === 'number')) {
    return null;
  }

  return {
    bpeRanks,
    specialTokens: specialTokens as Record<string, number>,
    patStr,
  };
}

async function loadNodeEncoder(): Promise<ResolvedEncoder | null> {
  if (!nodeEncoderPromise) {
    nodeEncoderPromise = (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ NODE_TIKTOKEN_SPECIFIER)) as Record<
          string,
          unknown
        >;
        const encoder = createNodeEncoder(mod);
        if (!encoder) {
          // Fail fast for all callers sharing this probe; only a later fresh call retries.
          nodeEncoderPromise = null;
        }
        return encoder;
      } catch (error) {
        logOnce('Failed to load tiktoken (node)', error);
        // Clear the failed promise so later probes can retry after transient loader issues.
        // Callers already awaiting this attempt still observe the same null result.
        nodeEncoderPromise = null;
        return null;
      }
    })();
  }
  return nodeEncoderPromise;
}

async function loadBrowserEncoder(): Promise<ResolvedEncoder | null> {
  if (!browserEncoderPromise) {
    browserEncoderPromise = (async () => {
      try {
        const encoder = await instantiateBrowserEncoder();
        if (!encoder) {
          // Fail fast for all callers sharing this probe; only a later fresh call retries.
          browserEncoderPromise = null;
        }
        return encoder;
      } catch (error) {
        logOnce('Failed to load tiktoken (browser)', error);
        // Clear the failed promise so later probes can retry after transient init issues.
        // Callers already awaiting this attempt still observe the same null result.
        browserEncoderPromise = null;
        return null;
      }
    })();
  }
  return browserEncoderPromise;
}

async function resolveEncoder(): Promise<ResolvedEncoder | null> {
  return isBrowserLike() ? loadBrowserEncoder() : loadNodeEncoder();
}

function resetEncoderLoadState(): void {
  nodeEncoderPromise = null;
  browserEncoderPromise = null;
  loadFailureLogged = false;
  lastEncoderFailureReason = null;
}

function disposeResolvedEncoder(promise: Promise<ResolvedEncoder | null> | null): void {
  if (!promise) {
    return;
  }
  void promise
    .then((encoder) => {
      encoder?.dispose?.();
    })
    .catch(() => {
      // Ignore failed initialization during disposal/reset.
    });
}

export function disposeAccurateTokenCountingRuntime(): void {
  const pendingNodeEncoder = nodeEncoderPromise;
  const pendingBrowserEncoder = browserEncoderPromise;
  resetEncoderLoadState();
  disposeResolvedEncoder(pendingNodeEncoder);
  disposeResolvedEncoder(pendingBrowserEncoder);
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
    return encoder.encodeContent(text).length;
  } catch (error) {
    logOnce('tiktoken encode failed', error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Accurate token counting failed: ${message}`);
  }
}
