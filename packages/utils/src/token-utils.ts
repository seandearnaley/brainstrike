/**
 * Utility functions for estimating token counts for large language models
 */

/**
 * Accurately count tokens using OpenAI's tiktoken encoding
 * This provides exact counts for GPT-4 and a good approximation for Claude
 *
 * @param text - The text to count tokens for
 * @returns The number of tokens in the text
 */
type NodeWorker = import('node:worker_threads').Worker;

interface WorkerRequest {
  id: number;
  method: 'countTokensAccurate' | 'calculateGroupTokens';
  text?: string;
  texts?: string[];
}

interface WorkerResponse {
  id: number;
  result?: number;
  error?: string;
}

let tokenizerWorker: NodeWorker | null = null;
let requestId = 0;
const callbacks = new Map<number, { resolve: (n: number) => void; reject: (err: Error) => void }>();

async function initWorker(): Promise<NodeWorker> {
  // Only run in Node.js environment
  if (typeof window !== 'undefined') {
    throw new Error('Tokenizer worker only available in Node.js environment');
  }

  // biome-ignore lint/complexity/useLiteralKeys: env access
  if (process.env['DISABLE_TOKEN_WORKER']) {
    throw new Error('Tokenizer worker disabled');
  }

  if (!tokenizerWorker) {
    try {
      // Only import Node.js modules when not in browser environment
      if (typeof window === 'undefined') {
        const { createRequire } = await import('node:module');
        const { Worker } = await import('node:worker_threads');
        const require = createRequire(import.meta.url);
        // Use package resolution instead of relative path
        const workerPath = require.resolve('@brainstrike/workers/tokenizer-worker');
        const modulePath = require.resolve('gpt-tokenizer');
        tokenizerWorker = new Worker(workerPath, {
          workerData: { modulePath },
          type: 'module',
        } as import('node:worker_threads').WorkerOptions & { type: 'module' });

        tokenizerWorker.on('message', (msg: WorkerResponse) => {
          const cb = callbacks.get(msg.id);
          if (cb) {
            callbacks.delete(msg.id);
            if (msg.error) {
              cb.reject(new Error(msg.error));
            } else {
              cb.resolve(msg.result ?? 0);
            }
          }
        });

        tokenizerWorker.on('error', (err) => {
          console.warn('Tokenizer worker error', err);
          tokenizerWorker?.terminate();
          tokenizerWorker = null;
        });

        tokenizerWorker.on('exit', () => {
          tokenizerWorker = null;
        });
      } else {
        throw new Error('Tokenizer worker only available in Node.js environment');
      }
    } catch (e) {
      tokenizerWorker = null;
      throw e;
    }
  }

  return tokenizerWorker;
}

async function runWorker(
  method: WorkerRequest['method'],
  payload: Omit<WorkerRequest, 'id' | 'method'>
): Promise<number> {
  const worker = await initWorker();
  return new Promise((resolve, reject) => {
    const id = requestId++;
    callbacks.set(id, { resolve, reject });
    worker.postMessage({ id, method, ...payload } satisfies WorkerRequest);
  });
}

export async function countTokensAccurate(text: string): Promise<number> {
  try {
    return await runWorker('countTokensAccurate', { text });
  } catch (_e) {
    console.warn('Tokenizer worker unavailable, using heuristic estimate instead');
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
export async function calculateGroupTokens(texts: string[], useHeuristic = false): Promise<number> {
  if (useHeuristic) {
    return texts.reduce((total, text) => total + countTokensHeuristic(text), 0);
  }
  try {
    return await runWorker('calculateGroupTokens', { texts });
  } catch (_e) {
    console.warn('Tokenizer worker unavailable, using heuristic estimate instead');
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
