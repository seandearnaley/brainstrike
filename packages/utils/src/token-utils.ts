/**
 * Utility functions for estimating token counts for large language models
 */

type EncodeFn = (text: string) => Uint32Array;

const DEFAULT_MODEL = 'gpt-4o';
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

const isBrowserLike = () =>
  typeof window !== 'undefined' ||
  (typeof self !== 'undefined' &&
    typeof (self as { importScripts?: unknown }).importScripts === 'function');

function tryCreateEncoder(factory: EncoderFactory | undefined, input: string): EncodeFn | null {
  if (!factory) return null;
  try {
    const encoder = factory(input);
    return (text: string) => encoder.encode(text);
  } catch {
    return null;
  }
}

function logTiktokenFailure(runtime: 'node' | 'browser', error: unknown) {
  if (!loadFailureLogged) {
    loadFailureLogged = true;
    console.warn(
      `[token-utils] Failed to load tiktoken (${runtime}); falling back to heuristic`,
      error
    );
  }
}

function createNodeEncoder(mod: Record<string, unknown>): EncodeFn | null {
  const encodingForModel = mod['encoding_for_model'] as EncoderFactory | undefined;
  const getEncoding = mod['get_encoding'] as EncoderFactory | undefined;
  return (
    tryCreateEncoder(encodingForModel, DEFAULT_MODEL) ??
    tryCreateEncoder(getEncoding, DEFAULT_ENCODING)
  );
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

  if (!initFn || !encoderCtor || !encoderConfig) {
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
  const wasmUrl = module['default'];
  if (typeof wasmUrl !== 'string') {
    throw new Error('tiktoken wasm asset not resolved as URL');
  }

  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available in this environment');
  }

  const response = await fetchFn(wasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch tiktoken wasm asset: ${response.status}`);
  }
  return response.arrayBuffer();
}

function extractEncoderConfig(module: Record<string, unknown>): {
  bpeRanks: string;
  specialTokens: Record<string, number>;
  patStr: string;
} | null {
  const payload = module['default'] as Record<string, unknown> | undefined;
  if (!payload) return null;

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
        const mod = (await import('tiktoken')) as Record<string, unknown>;
        return createNodeEncoder(mod);
      } catch (error) {
        logTiktokenFailure('node', error);
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
        logTiktokenFailure('browser', error);
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

/**
 * Accurately count tokens using the wasm-backed tiktoken bindings. Falls back to heuristic estimation when the
 * bindings are unavailable (e.g., unsupported runtime or transient load failure).
 */
export async function countTokensAccurate(text: string): Promise<number> {
  if (!text) return 0;
  const encoder = await resolveEncoder();
  if (!encoder) {
    return countTokensHeuristic(text);
  }

  try {
    return encoder(text).length;
  } catch (error) {
    if (!loadFailureLogged) {
      loadFailureLogged = true;
      console.warn('[token-utils] tiktoken encode failed; falling back to heuristic', error);
    }
    return countTokensHeuristic(text);
  }
}

/**
 * Estimate token count using the character heuristic (1 token ≈ 4 chars)
 * This is less accurate but much faster for very large inputs
 *
 * Note: This is a rough approximation based on OpenAI's observation that
 * on average, one token is about 4 characters in English text. The actual
 * ratio varies significantly by language and content type:
 * - English: ~4 chars/token
 * - Code: ~3-4 chars/token
 * - Chinese/Japanese: ~1-2 chars/token
 * - URLs, base64: ~1 char/token
 *
 * Error margin: ±20-30% for typical English text, higher for other languages
 * Reference: https://platform.openai.com/docs/guides/tokens
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated number of tokens in the text
 */
export function countTokensHeuristic(text: string): number {
  const chars = text.length;
  // ~4 chars per token on average in English
  return Math.ceil(chars / 4);
}

/**
 * Format a token count for display
 *
 * @param count - The token count to format
 * @returns A formatted string (e.g., "1.2K tokens")
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 1000000) {
    return `${(count / 1000).toFixed(1)}K tokens`;
  }

  return `${(count / 1000000).toFixed(1)}M tokens`;
}

/**
 * Calculate token count for a group of texts
 *
 * @param texts - Array of text strings
 * @param useHeuristic - Whether to use the faster heuristic method
 * @returns Total token count for all texts
 */
export async function calculateGroupTokens(texts: string[]): Promise<number> {
  if (texts.length === 0) return 0;
  const encoder = await resolveEncoder();
  if (!encoder) {
    return texts.reduce((total, text) => total + countTokensHeuristic(text), 0);
  }

  try {
    return texts.reduce((total, text) => total + encoder(text).length, 0);
  } catch (error) {
    if (!loadFailureLogged) {
      loadFailureLogged = true;
      console.warn('[token-utils] Batch token count failed; falling back to heuristic', error);
    }
    return texts.reduce((total, text) => total + countTokensHeuristic(text), 0);
  }
}

/**
 * Estimate the cost of tokens at standard OpenAI GPT-4 rates
 * This is just an estimate and actual costs may vary
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens (optional)
 * @returns Estimated cost in USD
 */
export function estimateTokenCost(inputTokens: number, outputTokens = 0): number {
  // Current GPT-4 rates as of March 2025: $10/1M input, $30/1M output tokens
  const inputCost = inputTokens * 0.00001; // $0.01 per 1K tokens
  const outputCost = outputTokens * 0.00003; // $0.03 per 1K tokens
  return inputCost + outputCost;
}
