/**
 * Backend for local LLM inference using transformers.js
 *
 * Supports text generation with tool/function calling via ONNX models.
 */
import { createLogger } from '@brainstrike/utils';
import type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmProviderStatus,
  LocalLlmToolCall,
} from './types';

const logger = createLogger('LocalLlmBackend');

// Transformers.js types (dynamically imported)
interface ProgressInfo {
  file?: string;
  loaded?: number;
  status: string;
  total?: number;
}

// Chat message for pipeline input
// Includes all standard chat roles - pipeline handles them appropriately
interface ChatMessage {
  content: string;
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
}

// Pipeline output for text generation
interface TextGenerationOutput {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  generated_text: string | ChatMessage[];
}

// Text generation pipeline type
interface TextGenerationPipeline {
  dispose?: () => Promise<void>;
  (
    messages: ChatMessage[] | string,
    options?: {
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      max_new_tokens?: number;
      temperature?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      top_p?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      top_k?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      do_sample?: boolean;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      repetition_penalty?: number;
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_full_text?: boolean;
    }
  ): Promise<TextGenerationOutput[]>;
}

// Pipeline factory function type
type PipelineFunction = (
  task: 'text-generation',
  model: string,
  options?: {
    device?: string;
    dtype?: string;
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    progress_callback?: (progress: ProgressInfo) => void;
  }
) => Promise<TextGenerationPipeline>;

// Tokenizer type for token counting
interface Tokenizer {
  encode: (text: string) => { length: number };
}

// AutoTokenizer factory type
interface AutoTokenizerFactory {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  from_pretrained: (
    modelId: string,
    // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
    options?: { progress_callback?: (progress: ProgressInfo) => void }
  ) => Promise<Tokenizer>;
}

interface TransformersModule {
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
  AutoTokenizer: AutoTokenizerFactory;
  pipeline: PipelineFunction;
}

/**
 * Type guard for validating dynamically imported TransformersModule.
 * Ensures the module has the required structure before use.
 * Uses bracket notation for index signature properties (TS4111 compliance).
 */
function isTransformersModule(mod: unknown): mod is TransformersModule {
  if (!mod || typeof mod !== 'object') {
    return false;
  }

  const candidate = mod as Record<string, unknown>;

  // Validate pipeline function exists (bracket notation for index signature)
  if (typeof candidate['pipeline'] !== 'function') {
    return false;
  }

  // Validate AutoTokenizer class exists with from_pretrained static method
  // AutoTokenizer is a class (typeof === 'function' in JS), not an object
  const autoTokenizer = candidate['AutoTokenizer'];
  if (typeof autoTokenizer !== 'function') {
    return false;
  }

  // Check for static from_pretrained method on the class
  // Use 'in' operator which works with any object-like value including functions
  if (!('from_pretrained' in autoTokenizer)) {
    return false;
  }
  // Validate it's actually a function
  // biome-ignore lint/style/useNamingConvention: Matches transformers.js API (snake_case)
  const fromPretrained = (autoTokenizer as { from_pretrained: unknown }).from_pretrained;
  if (typeof fromPretrained !== 'function') {
    return false;
  }

  return true;
}

// Module-level cache for transformers.js
let transformersModule: TransformersModule | null = null;
let transformersModulePromise: Promise<TransformersModule> | null = null;

/**
 * Helper function to load and validate the transformers module.
 * Separated to avoid complex union types in promise chains.
 */
async function loadTransformersModule(): Promise<TransformersModule> {
  const mod: unknown = await import('@huggingface/transformers');

  // Runtime validation using type guard
  if (!isTransformersModule(mod)) {
    throw new Error(
      'Invalid transformers.js module structure: expected pipeline function and AutoTokenizer.from_pretrained. ' +
        'The @huggingface/transformers package may be incompatible or not properly installed.'
    );
  }

  // After type guard validation, mod is confirmed as TransformersModule
  return mod;
}

async function getTransformersModule(): Promise<TransformersModule> {
  if (transformersModule) {
    return transformersModule;
  }
  if (!transformersModulePromise) {
    transformersModulePromise = loadTransformersModule();
  }
  transformersModule = await transformersModulePromise;
  return transformersModule;
}

/**
 * Open the browser Cache API with user-friendly error handling.
 * Throws descriptive errors for SecurityError (permission denied).
 */
async function openModelCache(): Promise<Cache> {
  try {
    return await caches.open('transformers-cache');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Build environment context for better debugging
    const context = {
      cacheApiAvailable: typeof caches !== 'undefined',
      isSecureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : 'unknown',
    };

    if (error instanceof DOMException && error.name === 'SecurityError') {
      logger.error('Cache access denied', { ...context, originalError: message });
      throw new Error(
        `Cache access denied: Storage permissions may be blocked. Please enable storage access in browser settings. (${message})`
      );
    }
    logger.error('Failed to open model cache', { ...context, originalError: message });
    throw new Error(`Failed to open model cache: ${message}`);
  }
}

/**
 * Store a response in cache with user-friendly quota error handling.
 */
async function storeInCache(
  cache: Cache,
  url: string,
  response: Response,
  filePath: string
): Promise<void> {
  try {
    await cache.put(url, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error(
        `Storage quota exceeded while caching model file. Free up browser storage or clear site data. File: ${filePath}`
      );
    }
    throw new Error(`Failed to cache model file ${filePath}: ${message}`);
  }
}

/**
 * Build cache key for storing verification metadata.
 * This tracks which checksum was used to verify a cached file.
 */
function getVerificationMetadataKey(modelId: string, filePath: string): string {
  return `verified:${modelId}:${filePath}`;
}

/**
 * Check if a cached file was verified with the current expected checksum.
 * Returns false if:
 * - No verification metadata exists (file cached before checksums were added)
 * - Verification metadata doesn't match current expected checksum
 */
async function isCacheVerifiedWithCurrentChecksum(
  cache: Cache,
  modelId: string,
  filePath: string
): Promise<boolean> {
  const expectedChecksums = runtimeModelChecksums.get(modelId);
  if (!expectedChecksums || expectedChecksums.onnxSha256 === 'pending-verification') {
    // No checksum to verify against, or still pending - consider it valid
    return true;
  }

  const metadataKey = getVerificationMetadataKey(modelId, filePath);
  try {
    const metadataResponse = await cache.match(metadataKey);
    if (!metadataResponse) {
      // No verification metadata - file was cached before checksum verification was added
      logger.debug('No verification metadata for cached file', { modelId, filePath });
      return false;
    }

    const metadata = await metadataResponse.json();
    const storedChecksum = metadata?.verifiedChecksum;

    if (storedChecksum !== expectedChecksums.onnxSha256) {
      logger.info('Cached file verification metadata outdated', {
        modelId,
        filePath,
        storedChecksum: storedChecksum?.substring(0, 16),
        expectedChecksum: expectedChecksums.onnxSha256.substring(0, 16),
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.debug('Failed to read verification metadata', {
      modelId,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Store verification metadata after successful integrity check.
 */
async function storeVerificationMetadata(
  cache: Cache,
  modelId: string,
  filePath: string,
  verifiedChecksum: string
): Promise<void> {
  const metadataKey = getVerificationMetadataKey(modelId, filePath);
  const metadata = {
    verifiedChecksum,
    verifiedAt: new Date().toISOString(),
  };

  try {
    const response = Response.json(metadata);
    await cache.put(metadataKey, response);
    logger.debug('Stored verification metadata', { modelId, filePath });
  } catch (error) {
    // Non-fatal - verification still succeeded
    logger.debug('Failed to store verification metadata', {
      modelId,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Download a file from HuggingFace Hub with streaming to avoid memory issues.
 * Uses TransformStream for progress tracking without buffering the entire file.
 * Stores directly in browser Cache API which transformers.js uses internally.
 *
 * Cache verification strategy:
 * - On fresh download: verify integrity and store verification metadata
 * - On cache hit: check if verification metadata matches current expected checksum
 * - If metadata is outdated/missing: invalidate cache and re-download with verification
 *
 * Based on HuggingFace transformers.js GitHub issue #1041.
 */
async function downloadFileToCache(
  modelId: string,
  filePath: string,
  onProgress?: (loaded: number, total: number) => void,
  verifyIntegrity?: (data: ArrayBuffer) => Promise<void>
): Promise<void> {
  const url = `https://huggingface.co/${modelId}/resolve/main/${filePath}`;
  const cache = await openModelCache();

  // Check if already cached (non-fatal on error - proceed with download)
  try {
    const cachedResponse = await cache.match(url);
    if (cachedResponse) {
      // File is cached - check if it was verified with current checksum
      if (verifyIntegrity) {
        const isVerified = await isCacheVerifiedWithCurrentChecksum(cache, modelId, filePath);
        if (isVerified) {
          // Cache is valid and verified
          logger.debug('File already cached and verified', { modelId, filePath });
          onProgress?.(1, 1);
          return;
        }
        // Verification metadata outdated or missing - invalidate and re-download
        logger.info('Invalidating cached file for re-verification', { modelId, filePath });
        await cache.delete(url);
      } else {
        // No verification requested - use cache as-is
        logger.debug('File already cached', { modelId, filePath });
        onProgress?.(1, 1);
        return;
      }
    }
  } catch (matchError) {
    logger.debug('Cache match failed, will re-download', {
      modelId,
      filePath,
      error: matchError instanceof Error ? matchError.message : String(matchError),
    });
  }

  // Fetch with streaming
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: Failed to fetch ${filePath}`);
  }

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;

  if (!response.body) {
    throw new Error('Response body is null');
  }

  // If verification is requested, we need to accumulate the file content
  // while streaming it to cache. This avoids re-reading from cache.
  //
  // MEMORY NOTE: For large models (1-2GB), accumulating all chunks in memory
  // could be problematic on constrained devices. This is an intentional trade-off:
  // - Pro: Avoids re-reading from cache after download (significant I/O savings)
  // - Con: Temporarily doubles memory usage during verification
  // The memory is released immediately after verification completes (see finally block).
  const chunks: Uint8Array[] = [];

  // Create a TransformStream for progress tracking
  let loaded = 0;
  const progressTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.length;
      if (total > 0) {
        onProgress?.(loaded, total);
      }
      if (verifyIntegrity) {
        chunks.push(chunk);
      }
      controller.enqueue(chunk);
    },
  });

  // Pipe through progress transform and create cache response
  const transformedStream = response.body.pipeThrough(progressTransform);
  const cacheResponse = new Response(transformedStream, {
    headers: {
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Content-Length': String(total),
    },
  });

  // Cache the file first
  await storeInCache(cache, url, cacheResponse, filePath);
  logger.debug('File downloaded and cached', { modelId, filePath, size: loaded });

  // Verify integrity if requested
  if (verifyIntegrity && chunks.length > 0) {
    await performIntegrityCheck(verifyIntegrity, chunks, loaded, cache, url, modelId, filePath);
  }
}

/**
 * Perform integrity check on accumulated file chunks.
 * Extracted to reduce complexity of downloadFileToCache.
 * Stores verification metadata on success for cache invalidation detection.
 */
async function performIntegrityCheck(
  verifyIntegrity: (data: ArrayBuffer) => Promise<void>,
  chunks: Uint8Array[],
  totalSize: number,
  cache: Cache,
  url: string,
  modelId: string,
  filePath: string
): Promise<void> {
  // Local reference to mutable chunks array to clear it safely
  const localChunks = chunks;

  try {
    // Combine chunks into a single ArrayBuffer for verification
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of localChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    await verifyIntegrity(combined.buffer);

    // Verification succeeded - store metadata for cache invalidation detection
    const expectedChecksums = runtimeModelChecksums.get(modelId);
    if (expectedChecksums && expectedChecksums.onnxSha256 !== 'pending-verification') {
      await storeVerificationMetadata(cache, modelId, filePath, expectedChecksums.onnxSha256);
    }
  } catch (error) {
    // Verification failed - delete the corrupted file from cache to prevent "cache poisoning"
    // If we leave it, the next run will find it in cache and skip verification
    try {
      await cache.delete(url);
      logger.warn('Deleted corrupted file from cache', { modelId, filePath });
    } catch (deleteError) {
      logger.error('Failed to delete corrupted file from cache', {
        modelId,
        filePath,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }

    // Clear memory immediately on error
    localChunks.length = 0;

    // Re-throw to fail the download process
    throw error;
  } finally {
    // Clear chunks to free memory in all cases
    localChunks.length = 0;
  }
}

/**
 * Check output length for ReDoS protection.
 * Throws descriptive error if output exceeds maximum length.
 */
function validateOutputLength(output: string, parser: string): void {
  if (output.length > MAX_OUTPUT_LENGTH) {
    throw new Error(
      `Tool call output exceeds maximum length (${output.length} > ${MAX_OUTPUT_LENGTH} bytes). ` +
        `Parser: ${parser}. This limit prevents ReDoS attacks. ` +
        'If this is a legitimate use case, consider chunking the output.'
    );
  }
}

/**
 * Build a LocalLlmToolCall from a parsed function name and arguments.
 * Centralizes the repeated tool call construction across all parsers.
 */
function buildToolCall(name: string, args: string): LocalLlmToolCall {
  return {
    id: `call_${crypto.randomUUID()}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

/**
 * Parse FunctionGemma format: <start_function_call>call:name{args}<end_function_call>
 * Uses iterative string parsing instead of regex to prevent ReDoS attacks.
 */
function parseGemmaFormat(output: string): LocalLlmToolCall | null {
  // ReDoS protection: validate output length
  validateOutputLength(output, 'gemma');

  // Iterative parsing instead of regex to prevent ReDoS
  const startTag = '<start_function_call>call:';
  const endTag = '<end_function_call>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const content = output.substring(startIdx + startTag.length, endIdx);

  // Parse name{args} format
  const braceIdx = content.indexOf('{');
  if (braceIdx === -1) {
    return null;
  }

  const closeBraceIdx = content.lastIndexOf('}');
  if (closeBraceIdx === -1 || closeBraceIdx < braceIdx) {
    return null;
  }

  const name = content.substring(0, braceIdx).trim();
  const argsStr = content.substring(braceIdx + 1, closeBraceIdx);

  // Validate name is alphanumeric
  if (!/^\w+$/.test(name)) {
    return null;
  }

  const args: Record<string, string> = {};
  if (argsStr) {
    for (const pair of argsStr.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }

      const key = pair.substring(0, colonIdx).trim();
      const value = pair
        .substring(colonIdx + 1)
        .replace(/<escape>/g, '')
        .trim();

      if (key && value) {
        args[key] = value;
      }
    }
  }

  return buildToolCall(name, JSON.stringify(args));
}

/**
 * Parse Qwen format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * Uses iterative string parsing instead of regex to prevent ReDoS attacks.
 */
function parseQwenFormat(output: string): LocalLlmToolCall | null {
  // ReDoS protection: validate output length
  validateOutputLength(output, 'qwen');

  // Iterative parsing instead of regex to prevent ReDoS
  const startTag = '<tool_call>';
  const endTag = '</tool_call>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const jsonContent = output.substring(startIdx + startTag.length, endIdx).trim();
  if (!jsonContent) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonContent) as {
      name: string;
      arguments: Record<string, unknown>;
    };

    // Validate parsed structure
    if (typeof parsed.name !== 'string') {
      logger.debug('Qwen tool call missing name field');
      return null;
    }

    return buildToolCall(parsed.name, JSON.stringify(parsed.arguments ?? {}));
  } catch {
    logger.debug('Failed to parse Qwen tool call JSON', { raw: jsonContent });
    return null;
  }
}

/**
 * Parse generic JSON format: {"name": "...", "arguments": {...}}
 * Uses iterative string parsing with JSON.parse instead of regex to prevent ReDoS attacks.
 */
function parseGenericJsonFormat(output: string): LocalLlmToolCall | null {
  // ReDoS protection: validate output length
  validateOutputLength(output, 'genericJson');

  // Find potential JSON object boundaries using iterative search
  const namePattern = '"name"';
  const nameIdx = output.indexOf(namePattern);
  if (nameIdx === -1) {
    return null;
  }

  // Find the opening brace before "name"
  let startIdx = nameIdx;
  while (startIdx > 0 && output[startIdx] !== '{') {
    startIdx--;
  }
  if (output[startIdx] !== '{') {
    return null;
  }

  // Find matching closing brace by counting brace depth
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < output.length; i++) {
    if (output[i] === '{') {
      depth++;
    }
    if (output[i] === '}') {
      depth--;
    }
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }
  if (depth !== 0) {
    return null;
  }

  const jsonStr = output.substring(startIdx, endIdx);

  try {
    const parsed = JSON.parse(jsonStr) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };

    // Validate required fields
    if (typeof parsed.name !== 'string' || !/^\w+$/.test(parsed.name)) {
      return null;
    }

    return buildToolCall(parsed.name, parsed.arguments ? JSON.stringify(parsed.arguments) : '{}');
  } catch {
    logger.debug('Failed to parse generic JSON tool call', { raw: jsonStr });
    return null;
  }
}

/**
 * Parse LFM2.5 Pythonic format: <|tool_call_start|>[func_name(arg="value")]<|tool_call_end|>
 * LFM2.5 outputs tool calls as Python-style function calls wrapped in special tokens.
 * Uses iterative string parsing for tag boundaries to prevent ReDoS attacks.
 *
 * Examples:
 * - <|tool_call_start|>[get_weather(location="Paris")]<|tool_call_end|>
 * - <|tool_call_start|>[search(query="AI news", limit=10)]<|tool_call_end|>
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parses multiple argument formats (strings, numbers, booleans)
function parseLfmFormat(output: string): LocalLlmToolCall | null {
  // ReDoS protection: validate output length
  validateOutputLength(output, 'lfm');

  // Iterative parsing for tag boundaries to prevent ReDoS
  const startTag = '<|tool_call_start|>';
  const endTag = '<|tool_call_end|>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const content = output.substring(startIdx + startTag.length, endIdx).trim();

  // Parse [func_name(args)] format
  if (!(content.startsWith('[') && content.endsWith(']'))) {
    return null;
  }

  const innerContent = content.substring(1, content.length - 1);
  const parenIdx = innerContent.indexOf('(');
  const closeParenIdx = innerContent.lastIndexOf(')');

  if (parenIdx === -1 || closeParenIdx === -1 || closeParenIdx < parenIdx) {
    return null;
  }

  const funcName = innerContent.substring(0, parenIdx).trim();
  const argsStr = innerContent.substring(parenIdx + 1, closeParenIdx);

  // Validate function name is alphanumeric
  if (!/^\w+$/.test(funcName)) {
    return null;
  }

  const args: Record<string, string | number | boolean> = {};

  if (argsStr) {
    // Parse Python-style kwargs using iterative approach
    // Split by comma, but handle commas inside quotes
    let currentArg = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i <= argsStr.length; i++) {
      const char = argsStr[i];

      if (i === argsStr.length || (char === ',' && !inQuote)) {
        // Process current argument
        const arg = currentArg.trim();
        if (arg) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            const key = arg.substring(0, eqIdx).trim();
            const value = arg.substring(eqIdx + 1).trim();

            if (/^\w+$/.test(key)) {
              // Parse value
              if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
              ) {
                args[key] = value.substring(1, value.length - 1);
              } else if (/^\d+(\.\d+)?$/.test(value)) {
                args[key] = Number.parseFloat(value);
              } else if (value.toLowerCase() === 'true') {
                args[key] = true;
              } else if (value.toLowerCase() === 'false') {
                args[key] = false;
              } else {
                args[key] = value;
              }
            }
          }
        }
        currentArg = '';
      } else {
        if ((char === '"' || char === "'") && (i === 0 || argsStr[i - 1] !== '\\')) {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar) {
            inQuote = false;
            quoteChar = '';
          }
        }
        currentArg += char;
      }
    }
  }

  return buildToolCall(funcName, JSON.stringify(args));
}

/**
 * Parse function call from model output
 * Supports multiple formats used by different models
 */
function parseFunctionCall(output: string): LocalLlmToolCall | null {
  return (
    parseLfmFormat(output) ??
    parseGemmaFormat(output) ??
    parseQwenFormat(output) ??
    parseGenericJsonFormat(output)
  );
}

/**
 * Models whose Jinja chat templates aren't supported by transformers.js's JS parser.
 * These need manual prompt formatting instead of relying on the chat template.
 *
 * The transformers.js Jinja parser doesn't support certain operators like
 * MultiplicativeBinaryOperator (array slicing with *), causing template errors.
 */
const MODELS_REQUIRING_MANUAL_FORMATTING = new Set(['onnx-community/functiongemma-270m-it-ONNX']);

/**
 * Maximum output length for tool call parsing (100KB).
 * Prevents ReDoS attacks from unbounded regex matching on large inputs.
 * Set to 100KB to support legitimate use cases like code generation.
 */
const MAX_OUTPUT_LENGTH = 100_000;

/**
 * Maximum model ID length to prevent excessively long inputs.
 */
const MAX_MODEL_ID_LENGTH = 100;

/**
 * Multiplier for estimating total GPU memory usage including runtime overhead.
 * WebGPU requires additional buffers beyond model weights for:
 * - Activation tensors during forward pass
 * - Temporary computation buffers
 * - KV cache for attention mechanisms
 */
const WEBGPU_MEMORY_OVERHEAD_MULTIPLIER = 1.5;

/**
 * Baseline allowlist of approved models that can be loaded.
 * These models are always allowed and cannot be removed at runtime.
 * This provides defense-in-depth against:
 * - Downloading malicious models from compromised repos
 * - DoS attacks via extremely large model downloads
 * - Exploiting vulnerabilities in specific ONNX parsers
 */
const BASELINE_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  'onnx-community/functiongemma-270m-it-ONNX',
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
  'onnx-community/Qwen3-0.6B-ONNX',
  'onnx-community/Qwen3-1.7B-ONNX',
]);

/**
 * Runtime-configurable allowlist that includes baseline + user-added models.
 * Use addAllowedModels() to extend at runtime from user preferences.
 */
const runtimeAllowedModels: Set<string> = new Set(BASELINE_ALLOWED_MODELS);

/**
 * HuggingFace model ID format: "owner/repo-name".
 * Allows alphanumeric, hyphens, underscores, periods.
 */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/**
 * Validate model ID format and path safety (without allowlist check).
 * Returns a reason string on failure, or null on success.
 */
function validateModelIdFormat(modelId: string): string | null {
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    return 'exceeds maximum length';
  }
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return 'invalid format';
  }
  if (modelId.includes('..') || modelId.includes('./') || modelId.includes('//')) {
    return 'contains path traversal pattern';
  }
  return null;
}

/**
 * Add models to the runtime allowlist.
 * This should be called with validated model IDs from user preferences.
 * Models are validated for format before being added.
 *
 * @param modelIds - Array of model IDs to add (must pass format validation)
 * @returns Object with arrays of successfully added and rejected model IDs
 */
export function addAllowedModels(modelIds: string[]): {
  added: string[];
  rejected: Array<{ modelId: string; reason: string }>;
} {
  const added: string[] = [];
  const rejected: Array<{ modelId: string; reason: string }> = [];

  for (const modelId of modelIds) {
    const reason = validateModelIdFormat(modelId);
    if (reason) {
      rejected.push({ modelId, reason });
      continue;
    }

    runtimeAllowedModels.add(modelId);
    added.push(modelId);
  }

  if (added.length > 0) {
    logger.info('Added models to runtime allowlist', { count: added.length, added });
  }
  if (rejected.length > 0) {
    logger.warn('Rejected invalid models from allowlist', { count: rejected.length, rejected });
  }

  return { added, rejected };
}

/**
 * Get the current list of allowed model IDs (baseline + runtime additions).
 */
export function getAllowedModels(): string[] {
  return Array.from(runtimeAllowedModels);
}

/**
 * Check if a model is in the allowlist (baseline or runtime-added).
 */
export function isModelAllowed(modelId: string): boolean {
  return runtimeAllowedModels.has(modelId);
}

/**
 * Model integrity checksums for verification.
 * Maps model ID to SHA256 hash of the main ONNX model file.
 * These are verified after download to detect tampering or corruption.
 */
interface ModelChecksums {
  /** Optional config.json hash for additional verification */
  configSha256?: string;
  /** SHA256 hash of the model's main ONNX file */
  onnxSha256: string;
}

/**
 * Baseline checksums for approved models.
 * These checksums were computed from known-good model files.
 *
 * To compute a checksum for a new model:
 * 1. Download the model's ONNX file from HuggingFace
 * 2. Run: shasum -a 256 <model_file>.onnx
 * 3. Add the hex hash to this map
 *
 * Note: Currently using placeholder values. These should be replaced
 * with actual checksums computed from verified model downloads.
 */
const BASELINE_MODEL_CHECKSUMS: ReadonlyMap<string, ModelChecksums> = new Map([
  // Checksums verified from Hugging Face model files

  // FunctionGemma uses q4 dtype: onnx/model_q4.onnx
  [
    'onnx-community/functiongemma-270m-it-ONNX',
    { onnxSha256: 'f3f12f387ee22d2b8c1b308bb6b2967ceb7c3466688950c5d7ccee29620ecede' },
  ],
  // LFM2.5 uses q4 dtype: onnx/model_q4.onnx
  [
    'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    { onnxSha256: '65d45073c4b9ce3281397d226df7cc95c2f7a7fa5328dcb1109d480f9fddbc7c' },
  ],
  // Qwen3-0.6B uses q4f16 dtype: onnx/model_q4f16.onnx
  [
    'onnx-community/Qwen3-0.6B-ONNX',
    { onnxSha256: '9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91' },
  ],
  // Qwen3-1.7B uses q4f16 dtype: onnx/model_q4f16.onnx
  [
    'onnx-community/Qwen3-1.7B-ONNX',
    { onnxSha256: 'fb85b44defdf43ace50c7a4937127e889b9f8a0483eb87a6c4151a815c5da3b5' },
  ],
]);

/**
 * Runtime-configurable checksums that includes baseline + user-added entries.
 */
const runtimeModelChecksums: Map<string, ModelChecksums> = new Map(BASELINE_MODEL_CHECKSUMS);

/**
 * Compute SHA256 hash of data using SubtleCrypto.
 * @param data - ArrayBuffer or Uint8Array to hash
 * @returns Hex-encoded SHA256 hash
 */
async function computeSha256(data: ArrayBuffer): Promise<string> {
  // SubtleCrypto is available in all modern browsers and Node.js 15+
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    logger.warn('SubtleCrypto not available, skipping integrity check');
    return 'unavailable';
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  // Convert to hex string
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Check if a model has a checksum registered (for testing purposes).
 *
 * @param modelId - HuggingFace model ID
 * @returns True if checksum is registered, false otherwise
 */
export function hasModelChecksum(modelId: string): boolean {
  return runtimeModelChecksums.has(modelId);
}

/**
 * Add or update model checksums at runtime.
 * This should be called with verified checksums from a trusted source.
 *
 * @param modelId - HuggingFace model ID
 * @param checksums - SHA256 checksums for model files
 */
export function setModelChecksums(modelId: string, checksums: ModelChecksums): void {
  if (validateModelIdFormat(modelId)) {
    logger.warn('Invalid model ID format for checksum registration', { modelId });
    return;
  }

  // Validate checksum format (64 hex chars or placeholder)
  const sha256Pattern = /^[a-f0-9]{64}$|^pending-verification$|^unavailable$/;
  if (!sha256Pattern.test(checksums.onnxSha256)) {
    logger.warn('Invalid SHA256 format for model checksum', {
      modelId,
      received: `${checksums.onnxSha256.substring(0, 20)}...`,
    });
    return;
  }

  runtimeModelChecksums.set(modelId, checksums);
  logger.debug('Registered model checksum', { modelId });
}

/**
 * Verify model integrity by comparing computed hash against expected checksum.
 *
 * @param modelId - HuggingFace model ID
 * @param data - Model data as ArrayBuffer
 * @returns True if verification passed or was skipped, throws on mismatch
 */
export async function verifyModelIntegrity(modelId: string, data: ArrayBuffer): Promise<boolean> {
  const expectedChecksums = runtimeModelChecksums.get(modelId);

  // No checksum registered - log warning but allow (for runtime-added models)
  if (!expectedChecksums) {
    logger.warn('No checksum registered for model, skipping integrity check', { modelId });
    return true;
  }

  // Skip verification for placeholder checksums
  if (expectedChecksums.onnxSha256 === 'pending-verification') {
    logger.debug('Model checksum is pending verification, skipping check', { modelId });
    return true;
  }

  const computedHash = await computeSha256(data);

  // SubtleCrypto unavailable - can't verify
  if (computedHash === 'unavailable') {
    return true;
  }

  if (computedHash !== expectedChecksums.onnxSha256) {
    const error = new Error(
      `Model integrity check failed for ${modelId}. ` +
        `Expected SHA256: ${expectedChecksums.onnxSha256.substring(0, 16)}..., ` +
        `Got: ${computedHash.substring(0, 16)}.... ` +
        'The model file may be corrupted or tampered with. ' +
        'Try clearing the cache and re-downloading.'
    );
    logger.error('Model integrity verification failed', {
      modelId,
      expected: expectedChecksums.onnxSha256.substring(0, 16),
      computed: computedHash.substring(0, 16),
    });
    throw error;
  }

  logger.debug('Model integrity verification passed', { modelId });
  return true;
}

/**
 * Validate HuggingFace model ID format and check against allowlist.
 * Provides multi-layer validation: format, path safety, and allowlist.
 */
function isValidModelId(modelId: string): boolean {
  const formatError = validateModelIdFormat(modelId);
  if (formatError) {
    logger.warn('Invalid model ID', { modelId, reason: formatError });
    return false;
  }

  if (!runtimeAllowedModels.has(modelId)) {
    logger.warn('Attempted to load unapproved model', { modelId });
    return false;
  }

  return true;
}

/**
 * Safety buffer for quota checks (10%).
 * Accounts for TOCTOU race conditions where storage usage may change
 * between the quota check and the actual download.
 */
const QUOTA_SAFETY_BUFFER = 1.1;

/**
 * Check if storage quota is sufficient for model download.
 * Throws descriptive error if insufficient space.
 *
 * **TOCTOU Note**: This is a best-effort check. Storage availability can change
 * between this check and the actual download (other tabs, processes, or browser
 * operations may consume storage). We mitigate this by:
 * 1. Requiring 10% buffer over the estimated size
 * 2. Handling QuotaExceededError during actual download
 * 3. Providing clear error messages for quota issues
 */
async function checkStorageQuota(estimatedSize: number): Promise<void> {
  // Storage API may not be available in all browsers
  if (typeof navigator === 'undefined') {
    return; // Skip check in non-browser environments
  }

  if (!('storage' in navigator) || typeof navigator.storage?.estimate !== 'function') {
    logger.debug('Storage API not available, skipping quota check');
    return;
  }

  // Apply safety buffer to account for TOCTOU race conditions
  const requiredSize = Math.ceil(estimatedSize * QUOTA_SAFETY_BUFFER);

  try {
    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);

    if (available < requiredSize) {
      const neededMB = Math.round(requiredSize / (1024 * 1024));
      const availableMB = Math.round(available / (1024 * 1024));
      throw new Error(
        `Insufficient storage: need ~${neededMB}MB (including 10% safety buffer), ` +
          `have ${availableMB}MB available. ` +
          'Try clearing browser cache or freeing disk space.'
      );
    }

    logger.debug('Storage quota check passed', {
      estimatedSizeMB: Math.round(estimatedSize / (1024 * 1024)),
      requiredWithBufferMB: Math.round(requiredSize / (1024 * 1024)),
      availableMB: Math.round(available / (1024 * 1024)),
    });
  } catch (error) {
    // Re-throw our own errors, log and continue for API errors
    if (error instanceof Error && error.message.includes('Insufficient storage')) {
      throw error;
    }
    logger.debug('Storage estimate failed, proceeding with download', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Track number of active aborted operations for resource monitoring.
 * Helps identify when abort signals are being triggered frequently
 * while background GPU/WASM work continues.
 */
let activeAbortedOperations = 0;

/**
 * Maximum number of concurrent aborted operations before circuit breaker trips.
 * When aborted operations accumulate (e.g., rapid user cancellations), the
 * background GPU/WASM work continues consuming resources. This limit prevents
 * memory exhaustion by rejecting new requests when too many are already pending.
 */
const MAX_CONCURRENT_ABORTED_OPERATIONS = 3;

/**
 * Wrap a promise with abort signal handling.
 * If the signal is aborted during execution, rejects with AbortError.
 *
 * LIMITATION: This wrapper enables early rejection but does NOT cancel
 * the underlying transformers.js pipeline operation. The GPU/WASM inference
 * will continue to completion in the background. This is a limitation of
 * the transformers.js library which doesn't expose cancellation APIs.
 * For large generations, this may result in wasted compute resources.
 *
 * CIRCUIT BREAKER: If too many aborted operations are pending (background
 * GPU/WASM work still running), new requests are rejected to prevent memory
 * exhaustion. Users should wait for pending operations to complete.
 */
function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  // Check if already aborted
  if (signal.aborted) {
    return Promise.reject(new DOMException('Generation aborted', 'AbortError'));
  }

  // Circuit breaker: prevent resource exhaustion from accumulated aborted operations
  if (activeAbortedOperations >= MAX_CONCURRENT_ABORTED_OPERATIONS) {
    logger.warn('Circuit breaker tripped: too many aborted operations pending', {
      activeAbortedOps: activeAbortedOperations,
      limit: MAX_CONCURRENT_ABORTED_OPERATIONS,
    });
    return Promise.reject(
      new Error(
        `Too many aborted operations (${activeAbortedOperations} pending). ` +
          'Background GPU/WASM work from previous aborts is still running. ' +
          'Please wait a moment for them to complete before starting new generations.'
      )
    );
  }

  // Track this operation for cleanup when promise resolves
  const operationId = crypto.randomUUID();
  let wasAborted = false;

  // When the underlying promise completes, decrement counter if aborted
  // void: Intentionally not awaiting - cleanup happens asynchronously in background
  void promise.finally(() => {
    if (wasAborted) {
      activeAbortedOperations = Math.max(0, activeAbortedOperations - 1);
      logger.debug('Aborted background operation completed', {
        operationId,
        remainingAbortedOps: activeAbortedOperations,
      });
    }
  });

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          wasAborted = true;
          activeAbortedOperations++;
          logger.warn(
            'Generation aborted but inference continues in background ' +
              '(transformers.js limitation - GPU/WASM work cannot be cancelled)',
            { operationId, activeAbortedOps: activeAbortedOperations }
          );
          reject(new DOMException('Generation aborted', 'AbortError'));
        },
        { once: true }
      );
    }),
  ]);
}

/**
 * Model-specific dtype requirements.
 * Different models work best with different quantization formats.
 * Qwen models specifically require q4f16 (per their model card).
 */
type ModelDtype = 'q4' | 'q4f16' | 'fp16' | 'fp32';

const MODEL_DTYPE_MAP: Record<string, ModelDtype> = {
  // Qwen models require q4f16 per their model cards
  'onnx-community/Qwen3-0.6B-ONNX': 'q4f16',
  // NOTE: Qwen3-1.7B removed - crashes due to WebGPU buffer limits in ONNX Runtime
  // See: https://github.com/huggingface/transformers.js/issues/1469
  // LiquidAI works with standard q4
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX': 'q4',
  // FunctionGemma uses q4
  'onnx-community/functiongemma-270m-it-ONNX': 'q4',
};

/**
 * Get the recommended dtype for a model.
 * Returns q4f16 for Qwen models, q4 for others.
 */
function getModelDtype(modelId: string): ModelDtype {
  const mapped = MODEL_DTYPE_MAP[modelId];
  if (mapped) {
    return mapped;
  }
  // Default: Qwen models use q4f16, others use q4
  if (modelId.includes('Qwen')) {
    return 'q4f16';
  }
  return 'q4';
}

/**
 * Estimated model file sizes in bytes for memory planning.
 * These are approximate sizes based on model card info.
 */
const MODEL_SIZE_ESTIMATES: Record<string, number> = {
  'onnx-community/Qwen3-0.6B-ONNX': 570 * 1024 * 1024, // ~570MB
  // NOTE: Qwen3-1.7B removed - crashes due to WebGPU buffer limits in ONNX Runtime
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX': 800 * 1024 * 1024, // ~800MB
  'onnx-community/functiongemma-270m-it-ONNX': 200 * 1024 * 1024, // ~200MB
};

/**
 * Get estimated model size in bytes.
 */
function getEstimatedModelSize(modelId: string): number {
  return MODEL_SIZE_ESTIMATES[modelId] ?? 500 * 1024 * 1024; // Default 500MB
}

/**
 * Get the ONNX model file paths for a given dtype.
 */
function getModelFilesForDtype(dtype: ModelDtype): string[] {
  switch (dtype) {
    case 'q4f16':
      // q4f16 is self-contained, no external data file
      return ['onnx/model_q4f16.onnx'];
    case 'q4':
      // q4 may have external data file (optional)
      return ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
    case 'fp16':
      return ['onnx/model_fp16.onnx', 'onnx/model_fp16.onnx_data'];
    case 'fp32':
      return ['onnx/model.onnx', 'onnx/model.onnx_data'];
    default:
      return ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
  }
}

/**
 * Models that support tool/function calling.
 * Each model may have different formats for receiving and outputting tool calls.
 */
const MODELS_SUPPORTING_TOOLS = new Set([
  'LiquidAI/LFM2.5-1.2B-Instruct-ONNX', // LFM2.5 - excellent tool calling support
  'onnx-community/functiongemma-270m-it-ONNX', // FunctionGemma - specialized for function calling
  'onnx-community/Qwen3-0.6B-ONNX', // Qwen3 supports tool calling
  'onnx-community/Qwen3-1.7B-ONNX', // Qwen3 supports tool calling
]);

/**
 * Check if a model supports tool/function calling.
 */
function supportsToolCalling(modelId: string): boolean {
  return MODELS_SUPPORTING_TOOLS.has(modelId);
}

/**
 * Tool definition type (matches LocalLlmToolDefinition from types.ts)
 */
interface ToolDefinition {
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
  type: 'function';
}

/**
 * Extract the common JSON representation of tool definitions.
 * Shared by formatters that serialize tools as JSON (FunctionGemma, LFM2.5).
 */
function toToolsJson(tools: ToolDefinition[]): Array<{
  name: string;
  description: string;
  parameters: ToolDefinition['function']['parameters'];
}> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

/**
 * Format tools as a system prompt for FunctionGemma.
 * FunctionGemma expects tools in a developer message with specific format.
 */
function formatToolsForFunctionGemma(tools: ToolDefinition[]): string {
  return `You are a helpful assistant with access to the following functions:

${JSON.stringify(toToolsJson(tools), null, 2)}

To use these functions, respond with:
<start_function_call>call:function_name{param1:value1, param2:value2}<end_function_call>

Only call a function when the user's request requires it. If no function is needed, respond normally.`;
}

/**
 * Format tools as a system prompt for Qwen models.
 * Qwen3 expects tools in a specific XML-like format.
 */
function formatToolsForQwen(tools: ToolDefinition[]): string {
  const toolDescriptions = tools
    .map((tool) => {
      const params = Object.entries(tool.function.parameters.properties)
        .map(
          ([name, prop]) => `  - ${name} (${prop.type}): ${prop.description ?? 'No description'}`
        )
        .join('\n');
      return `Function: ${tool.function.name}
Description: ${tool.function.description}
Parameters:
${params}`;
    })
    .join('\n\n');

  return `You are a helpful assistant with access to the following functions:

${toolDescriptions}

To call a function, use this format:
<tool_call>{"name": "function_name", "arguments": {"param1": "value1"}}</tool_call>

Only call a function when the user's request requires it. If no function is needed, respond normally.`;
}

/**
 * Format tools for LFM2.5 models.
 * LFM2.5 expects tools as a JSON array with "List of tools:" prefix in the system prompt.
 * Output format uses special tokens: <|tool_call_start|>[func(args)]<|tool_call_end|>
 */
function formatToolsForLfm(tools: ToolDefinition[]): string {
  return `List of tools: ${JSON.stringify(toToolsJson(tools))}`;
}

/**
 * Resolve which tool formatter and system message role to use for a given model.
 */
function resolveToolFormatter(modelId: string): {
  formatter: (tools: ToolDefinition[]) => string;
  role: 'system' | 'developer';
} {
  if (modelId.includes('LFM2') || modelId.includes('LiquidAI')) {
    return { formatter: formatToolsForLfm, role: 'system' };
  }
  if (modelId.includes('functiongemma')) {
    return { formatter: formatToolsForFunctionGemma, role: 'developer' };
  }
  // Qwen and generic models both use Qwen format with system role
  return { formatter: formatToolsForQwen, role: 'system' };
}

/**
 * Inject tools into messages based on model type.
 * Returns new messages array with tool definitions prepended as system/developer message.
 */
function injectToolsIntoMessages(
  messages: LocalLlmMessage[],
  tools: ToolDefinition[] | undefined,
  modelId: string
): LocalLlmMessage[] {
  if (!tools || tools.length === 0) {
    return messages;
  }

  if (!supportsToolCalling(modelId)) {
    logger.debug('Model does not support tool calling, ignoring tools', { modelId });
    return messages;
  }

  // Resolve model-specific tool formatter and system role
  const { formatter, role } = resolveToolFormatter(modelId);
  const toolSystemPrompt = formatter(tools);

  // Check if there's already a system message
  const hasSystemMessage = messages.some((m) => m.role === 'system' || m.role === 'developer');

  if (hasSystemMessage) {
    // Append tools to existing system message
    return messages.map((msg) => {
      if (msg.role === 'system' || msg.role === 'developer') {
        return {
          ...msg,
          content: `${msg.content}\n\n${toolSystemPrompt}`,
        };
      }
      return msg;
    });
  }

  // Prepend new system/developer message with tools
  return [{ role, content: toolSystemPrompt }, ...messages];
}

/**
 * Check if a model requires manual prompt formatting instead of using its chat template.
 */
function requiresManualPromptFormatting(modelId: string): boolean {
  return MODELS_REQUIRING_MANUAL_FORMATTING.has(modelId);
}

/**
 * Safely dispose a temporary pipeline, logging but not throwing on failure.
 */
async function disposePipelineSafely(
  pipeline: TextGenerationPipeline | null,
  context: string
): Promise<void> {
  if (!pipeline?.dispose) {
    return;
  }
  try {
    await pipeline.dispose();
    logger.debug(`Disposed temp pipeline after ${context}`);
  } catch (disposeError) {
    logger.debug('Error disposing temp pipeline', {
      error: disposeError instanceof Error ? disposeError.message : String(disposeError),
    });
  }
}

/**
 * Backend class for local LLM inference using pipeline API.
 * Uses transformers.js pipeline which handles tokenization internally,
 * avoiding issues with custom tokenizer classes.
 */
export class LocalLlmBackend {
  private pipeline: TextGenerationPipeline | null = null;
  private tokenizer: Tokenizer | null = null;
  private modelId: string | null = null;
  private selectedDevice: 'webgpu' | 'wasm' | null = null;
  private status: LocalLlmProviderStatus = { state: 'uninitialized' };

  /**
   * Initialize the backend with model configuration
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Initialization handles multiple device types and error cases
  async initialize(config: LocalLlmConfig): Promise<void> {
    // Validate modelId to prevent path traversal and SSRF attacks
    if (!isValidModelId(config.modelId)) {
      throw new Error(
        `Invalid model ID format: "${config.modelId}". Expected format: "owner/model-name" ` +
          '(alphanumeric, hyphens, underscores, and periods only).'
      );
    }

    if (this.pipeline && this.modelId === config.modelId) {
      return; // Already initialized with same model
    }

    // Dispose existing pipeline if switching
    if (this.pipeline) {
      await this.dispose();
    }

    this.status = { state: 'loading', progress: 0, message: 'Loading model...' };
    config.onProgress?.({
      stage: 'downloading',
      progress: 0,
      message: `Loading ${config.modelId}...`,
    });

    // Temporary pipeline reference for cleanup on failure
    let tempPipeline: TextGenerationPipeline | null = null;

    try {
      const transformers = await getTransformersModule();

      // Determine device
      this.selectedDevice = this.determineDevice(config.device);
      // Use model-specific dtype - Qwen models need q4f16, others use q4
      // Must match downloadModel() which pre-caches the correct files
      const dtype = getModelDtype(config.modelId);

      // Get GPU info for diagnostics
      const gpuInfo = await LocalLlmBackend.getWebGpuInfo();
      const estimatedModelSize = getEstimatedModelSize(config.modelId);

      // Log GPU info separately for visibility (console may not expand nested objects)
      if (gpuInfo) {
        logger.info(
          `GPU detected: ${gpuInfo.vendor} ${gpuInfo.device}, maxBuffer=${Math.round(gpuInfo.maxBufferSize / (1024 * 1024))}MB`
        );
      } else {
        logger.warn('No WebGPU adapter available - will use WASM fallback');
      }

      logger.info(
        `Initializing LLM: model=${config.modelId}, device=${this.selectedDevice}, dtype=${dtype}, modelSize=${Math.round(estimatedModelSize / (1024 * 1024))}MB`
      );

      // Check if model might be too large for GPU buffers
      if (gpuInfo && this.selectedDevice === 'webgpu') {
        const modelSizeWithOverhead = estimatedModelSize * WEBGPU_MEMORY_OVERHEAD_MULTIPLIER;
        if (modelSizeWithOverhead > gpuInfo.maxBufferSize) {
          logger.warn('Model may exceed WebGPU buffer limits', {
            modelId: config.modelId,
            estimatedModelSizeMB: Math.round(estimatedModelSize / (1024 * 1024)),
            modelSizeWithOverheadMB: Math.round(modelSizeWithOverhead / (1024 * 1024)),
            maxBufferSizeMB: Math.round(gpuInfo.maxBufferSize / (1024 * 1024)),
            gpuDevice: gpuInfo.device,
          });
        }
      }

      // Create progress callback
      const progressCallback = (progress: ProgressInfo) => {
        if (progress.status === 'progress' && progress.total) {
          const pct = Math.round(((progress.loaded ?? 0) / progress.total) * 100);
          this.status = {
            state: 'loading',
            progress: pct,
            message: `Downloading ${progress.file ?? 'model'}...`,
          };
          // Build progress object conditionally to satisfy exactOptionalPropertyTypes
          const progressData: Parameters<NonNullable<LocalLlmConfig['onProgress']>>[0] = {
            stage: 'downloading',
            progress: pct,
            message: `Downloading ${progress.file ?? 'model'}...`,
          };
          if (progress.file !== undefined) {
            progressData.file = progress.file;
          }
          config.onProgress?.(progressData);
        }
      };

      // Load using pipeline API - handles tokenization internally
      // This avoids issues with custom tokenizer classes like "TokenizersBackend"
      logger.info('Loading local LLM', { modelId: config.modelId, device: this.selectedDevice });

      const pipelineResult = await transformers.pipeline('text-generation', config.modelId, {
        device: this.selectedDevice,
        dtype,
        // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
        progress_callback: progressCallback,
      });

      // Validate pipeline result - must be a callable function
      if (typeof pipelineResult !== 'function') {
        throw new Error(
          `Invalid pipeline result: expected function, got ${typeof pipelineResult}. ` +
            'The transformers.js API may have changed.'
        );
      }
      tempPipeline = pipelineResult;

      // Load tokenizer for token counting (required for accurate usage tracking)
      const tokenizerResult = await transformers.AutoTokenizer.from_pretrained(config.modelId);

      // Validate tokenizer has encode method
      if (!tokenizerResult || typeof tokenizerResult.encode !== 'function') {
        await disposePipelineSafely(tempPipeline, 'tokenizer validation failure');
        throw new Error(
          'Invalid tokenizer result: expected object with encode method. ' +
            'The transformers.js API may have changed.'
        );
      }
      this.tokenizer = tokenizerResult;
      logger.debug('Tokenizer loaded for token counting', { modelId: config.modelId });

      // Only assign after successful initialization to prevent leaks
      this.pipeline = tempPipeline;
      this.modelId = config.modelId;

      this.status = { state: 'ready', device: this.selectedDevice };
      config.onProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'Model loaded',
      });

      logger.info('Local LLM loaded successfully', {
        modelId: config.modelId,
        device: this.selectedDevice,
      });
    } catch (error) {
      await disposePipelineSafely(tempPipeline, 'initialization failure');

      const message = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const stack = error instanceof Error ? error.stack : undefined;

      this.status = { state: 'error', error: message };

      // Log detailed error info for debugging
      logger.error('Failed to load local LLM', {
        modelId: config.modelId,
        device: this.selectedDevice,
        errorName,
        errorMessage: message,
        stack,
        // Check if this is a WASM abort (often memory-related)
        isAbort: message.includes('Aborted') || message === 'Aborted()',
      });

      throw error;
    }
  }

  /**
   * Format messages for Gemma-based models (including FunctionGemma).
   * Uses Gemma's special tokens: <start_of_turn>, <end_of_turn>, and role names.
   *
   * Format: <start_of_turn>role\ncontent<end_of_turn>
   * - user messages use "user" role
   * - assistant messages use "model" role (Gemma convention)
   * - developer/system messages use "developer" role (FunctionGemma specific)
   */
  private formatMessagesForGemma(messages: LocalLlmMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      let role: string;
      switch (msg.role) {
        case 'system':
        case 'developer':
          role = 'developer';
          break;
        case 'user':
          role = 'user';
          break;
        case 'assistant':
          role = 'model'; // Gemma uses "model" not "assistant"
          break;
        case 'tool':
          role = 'tool';
          break;
        default:
          role = 'user';
      }
      parts.push(`<start_of_turn>${role}\n${msg.content}<end_of_turn>`);
    }

    // Add start of model turn for response
    parts.push('<start_of_turn>model\n');

    return parts.join('\n');
  }

  /**
   * Format messages into a raw prompt string for the specific model.
   * Different models require different prompt formats.
   */
  private formatMessagesAsPrompt(messages: LocalLlmMessage[]): string {
    // FunctionGemma uses Gemma's chat format with special tokens
    if (this.modelId?.includes('functiongemma')) {
      return this.formatMessagesForGemma(messages);
    }

    // Default format for other models
    const parts: string[] = [];
    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
        case 'developer':
          parts.push(`System: ${msg.content}`);
          break;
        case 'user':
          parts.push(`User: ${msg.content}`);
          break;
        case 'assistant':
          parts.push(`Assistant: ${msg.content}`);
          break;
        case 'tool':
          parts.push(`Tool: ${msg.content}`);
          break;
        default:
          parts.push(msg.content);
      }
    }
    parts.push('Assistant:');
    return parts.join('\n\n');
  }

  /**
   * Generate text from messages using the pipeline API.
   * The pipeline handles tokenization internally, avoiding issues
   * with custom tokenizer classes.
   *
   * Models with unsupported Jinja templates are detected upfront and
   * use manual prompt formatting directly (no runtime fallback).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Generation handles tool injection, output parsing, and multiple formats
  async generate(
    messages: LocalLlmMessage[],
    options: LocalLlmGenerationOptions = {}
  ): Promise<LocalLlmGenerationResult> {
    if (!this.pipeline) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    if (!this.modelId) {
      throw new Error('Model ID not set. Initialize the model first.');
    }

    // Check for abort
    if (options.signal?.aborted) {
      throw new DOMException('Generation aborted', 'AbortError');
    }

    // Inject tools into messages if provided
    const messagesWithTools = injectToolsIntoMessages(messages, options.tools, this.modelId);

    // Build generation options for pipeline
    const generateOptions: Parameters<TextGenerationPipeline>[1] = {
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      max_new_tokens: options.maxNewTokens ?? 512,
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      do_sample: options.doSample ?? (options.temperature !== undefined && options.temperature > 0),
      // Only return the new text, not the full conversation
      // biome-ignore lint/style/useNamingConvention: Matches transformers.js API
      return_full_text: false,
    };

    // Add optional generation parameters
    if (options.temperature !== undefined) {
      generateOptions.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      generateOptions.top_p = options.topP;
    }
    if (options.topK !== undefined) {
      generateOptions.top_k = options.topK;
    }
    if (options.repetitionPenalty !== undefined) {
      generateOptions.repetition_penalty = options.repetitionPenalty;
    }

    let output: TextGenerationOutput[];
    let promptText = '';

    // Models with unsupported Jinja templates need manual prompt formatting.
    // This is determined upfront based on the model ID, not via runtime fallback.
    if (requiresManualPromptFormatting(this.modelId)) {
      logger.debug('Using manual prompt formatting for model', { modelId: this.modelId });
      promptText = this.formatMessagesAsPrompt(messagesWithTools);
      // Wrap pipeline call with abort signal handling
      output = await withAbortSignal(this.pipeline(promptText, generateOptions), options.signal);
    } else {
      // Convert messages to chat format expected by pipeline
      const chatMessages: ChatMessage[] = messagesWithTools.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
      // For token counting, concatenate all message contents
      promptText = messagesWithTools.map((m) => m.content).join('\n');
      // Wrap pipeline call with abort signal handling
      output = await withAbortSignal(this.pipeline(chatMessages, generateOptions), options.signal);
    }

    // Extract generated text from output
    // Pipeline returns array of { generated_text: string | ChatMessage[] }
    const firstOutput = output[0];
    let generatedText = '';

    if (firstOutput) {
      const generated = firstOutput.generated_text;
      if (typeof generated === 'string') {
        generatedText = generated;
      } else if (Array.isArray(generated)) {
        // If it returns chat messages, get the last assistant message
        const lastMessage = generated.at(-1);
        if (lastMessage?.role === 'assistant') {
          generatedText = lastMessage.content;
        }
      }
    }

    // Parse for tool calls
    const toolCall = parseFunctionCall(generatedText);

    // Count tokens using tokenizer - fail if not available
    if (!this.tokenizer) {
      throw new Error(
        'Tokenizer not available for token counting. Model initialization may have failed.'
      );
    }

    let promptTokens: number;
    let completionTokens: number;
    try {
      promptTokens = this.tokenizer.encode(promptText).length;
      completionTokens = this.tokenizer.encode(generatedText).length;
    } catch (tokenError) {
      throw new Error(
        `Token counting failed: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`
      );
    }

    logger.debug('Token counts', { promptTokens, completionTokens });

    // Build result
    const result: LocalLlmGenerationResult = {
      text: generatedText,
      finishReason: toolCall ? 'tool_calls' : 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };

    if (toolCall) {
      result.toolCalls = [toolCall];
    }

    return result;
  }

  /**
   * Get current status
   */
  getStatus(): LocalLlmProviderStatus {
    return this.status;
  }

  /**
   * Check if model is ready
   */
  isReady(): boolean {
    return this.status.state === 'ready';
  }

  /**
   * Get loaded model ID
   */
  getModelId(): string | null {
    return this.modelId;
  }

  /**
   * Dispose of loaded pipeline
   */
  async dispose(): Promise<void> {
    if (this.pipeline?.dispose) {
      try {
        await this.pipeline.dispose();
      } catch (error) {
        logger.debug('Error disposing pipeline', { error });
      }
    }
    this.pipeline = null;
    this.tokenizer = null;
    this.modelId = null;
    this.selectedDevice = null;
    this.status = { state: 'uninitialized' };
  }

  /**
   * Determine best device for inference
   */
  private determineDevice(requested?: 'webgpu' | 'wasm'): 'webgpu' | 'wasm' {
    if (requested === 'webgpu') {
      if (!LocalLlmBackend.isDeviceAvailable('webgpu')) {
        throw new Error(
          'WebGPU requested but not available. Use wasm or check browser compatibility.'
        );
      }
      return 'webgpu';
    }

    if (requested === 'wasm') {
      return 'wasm';
    }

    // Auto-detect: prefer WebGPU
    if (LocalLlmBackend.isDeviceAvailable('webgpu')) {
      return 'webgpu';
    }

    return 'wasm';
  }

  /**
   * Check device availability
   */
  static isDeviceAvailable(device: 'webgpu' | 'wasm'): boolean {
    if (device === 'webgpu') {
      return typeof navigator !== 'undefined' && 'gpu' in navigator;
    }
    return typeof WebAssembly !== 'undefined';
  }

  /**
   * Get WebGPU adapter information for diagnostics.
   * Returns null if WebGPU is not available or adapter request fails.
   */
  static async getWebGpuInfo(): Promise<{
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  } | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      return null;
    }

    try {
      // Runtime validation instead of unsafe type cast
      // WebGPU types aren't always available in TypeScript configs
      const gpuObj = navigator.gpu;
      if (!gpuObj || typeof gpuObj !== 'object') {
        logger.debug('navigator.gpu is not a valid object');
        return null;
      }

      // Validate requestAdapter exists and is callable
      const requestAdapter = (gpuObj as Record<string, unknown>)['requestAdapter'];
      if (typeof requestAdapter !== 'function') {
        logger.debug('navigator.gpu.requestAdapter is not a function');
        return null;
      }

      // Call requestAdapter with proper this binding
      const adapter = (await requestAdapter.call(gpuObj)) as Record<string, unknown> | null;
      if (!adapter) {
        logger.warn('WebGPU adapter request returned null - no compatible GPU found');
        return null;
      }

      // Validate adapter properties exist (older WebGPU implementations may not have them)
      const info = adapter['info'];
      const limits = adapter['limits'];

      if (!info || typeof info !== 'object' || !limits || typeof limits !== 'object') {
        logger.warn('WebGPU adapter missing info or limits', {
          hasInfo: Boolean(info),
          hasLimits: Boolean(limits),
        });
        return null;
      }

      // Type-safe property access after validation
      const infoObj = info as Record<string, unknown>;
      const limitsObj = limits as Record<string, unknown>;

      // Validate required properties exist and have correct types
      const vendor = infoObj['vendor'];
      const architecture = infoObj['architecture'];
      const device = infoObj['device'];
      const description = infoObj['description'];
      const maxBufferSize = limitsObj['maxBufferSize'];
      const maxStorageBufferBindingSize = limitsObj['maxStorageBufferBindingSize'];

      if (
        typeof vendor !== 'string' ||
        typeof maxBufferSize !== 'number' ||
        typeof maxStorageBufferBindingSize !== 'number'
      ) {
        logger.warn('WebGPU adapter info/limits have unexpected types');
        return null;
      }

      return {
        vendor,
        architecture: typeof architecture === 'string' ? architecture : 'unknown',
        device: typeof device === 'string' ? device : 'unknown',
        description: typeof description === 'string' ? description : '',
        maxBufferSize,
        maxStorageBufferBindingSize,
      };
    } catch (error) {
      logger.warn('Failed to get WebGPU adapter info', { error });
      return null;
    }
  }

  /**
   * Get best available device
   */
  static getBestDevice(): 'webgpu' | 'wasm' {
    if (LocalLlmBackend.isDeviceAvailable('webgpu')) {
      return 'webgpu';
    }
    return 'wasm';
  }

  /**
   * Download an LLM model to cache without initializing for inference.
   * Uses fetch streaming + Cache API to download files without loading into memory.
   * Based on HuggingFace transformers.js GitHub issue #1041.
   */
  static async downloadModel(
    modelId: string,
    options?: {
      cacheDir?: string;
      onProgress?: (progress: {
        stage: 'downloading' | 'ready';
        progress: number;
        message: string;
        file?: string;
      }) => void;
    }
  ): Promise<void> {
    // Validate modelId to prevent path traversal and SSRF attacks
    if (!isValidModelId(modelId)) {
      throw new Error(
        `Invalid model ID format: "${modelId}". Expected format: "owner/model-name" ` +
          '(alphanumeric, hyphens, underscores, and periods only). ' +
          'Only pre-approved models can be loaded for security.'
      );
    }

    // Check storage quota before downloading (prevents failed downloads)
    const estimatedSize = getEstimatedModelSize(modelId);
    await checkStorageQuota(estimatedSize);

    // Note: cacheDir option is ignored for browser Cache API storage
    // The Cache API uses the HuggingFace CDN URL as the cache key

    logger.info('Downloading LLM model files to cache', {
      modelId,
      estimatedSizeMB: Math.round(estimatedSize / (1024 * 1024)),
    });

    // Files needed for LLM inference - download each individually to cache
    // This avoids loading them into memory (unlike from_pretrained)
    const tokenizerFiles = ['tokenizer.json', 'tokenizer_config.json'];

    const configFiles = ['config.json', 'generation_config.json', 'chat_template.jinja'];

    // ONNX model files - use model-specific dtype
    // Qwen models use q4f16 (per their model cards), others use q4
    const dtype = getModelDtype(modelId);
    const modelFiles = getModelFilesForDtype(dtype);
    logger.info('Using dtype for model download', { modelId, dtype, modelFiles });

    const allFiles = [...tokenizerFiles, ...configFiles, ...modelFiles];
    let completedFiles = 0;

    interface DownloadProgressData {
      file?: string;
      message: string;
      progress: number;
      stage: 'downloading' | 'ready';
    }

    const updateProgress = (filename: string, fileProgress?: number) => {
      // If we have file-level progress, use it; otherwise use completed file count
      const overallProgress =
        fileProgress !== undefined
          ? Math.round(((completedFiles + fileProgress / 100) / allFiles.length) * 100)
          : Math.round((completedFiles / allFiles.length) * 100);

      const progressData: DownloadProgressData = {
        stage: 'downloading',
        progress: overallProgress,
        message: `Downloading ${filename}...`,
        file: filename,
      };
      options?.onProgress?.(progressData);
    };

    // Download files sequentially to avoid memory pressure
    for (const filename of allFiles) {
      updateProgress(filename, 0);

      try {
        // Create per-file progress callback
        const fileProgressCallback = (loaded: number, total: number) => {
          if (total > 0) {
            const pct = Math.round((loaded / total) * 100);
            updateProgress(filename, pct);
          }
        };

        // Download file to cache using streaming fetch
        // If this is the main model file, we attach a verification callback
        // to verify integrity without re-reading from cache.
        // Note: modelFiles is never empty as getModelFilesForDtype always returns at least one file
        const mainModelFile = modelFiles.length > 0 ? modelFiles[0] : undefined;
        const isMainModel = mainModelFile !== undefined && filename === mainModelFile;

        const verifyCallback = isMainModel
          ? async (data: ArrayBuffer) => {
              await verifyModelIntegrity(modelId, data);
              logger.info('Model integrity verified', { modelId, filename });
            }
          : undefined;

        await downloadFileToCache(modelId, filename, fileProgressCallback, verifyCallback);

        completedFiles++;
        logger.debug('Downloaded file', { modelId, filename });
      } catch (error) {
        // Some files are optional (e.g., onnx_data for smaller models, config files)
        const isOptional =
          filename.endsWith('_data') ||
          filename === 'generation_config.json' ||
          filename === 'chat_template.jinja';
        if (isOptional) {
          logger.debug('Optional file not found, skipping', { modelId, filename });
          completedFiles++;
        } else {
          logger.error('Failed to download required file', { modelId, filename, error });
          throw error;
        }
      }
    }

    options?.onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model downloaded',
    });

    logger.info('LLM model download complete', {
      modelId,
      dtype,
      filesDownloaded: allFiles.length,
    });
  }
}
