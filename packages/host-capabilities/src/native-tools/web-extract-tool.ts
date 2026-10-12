import type { WebExtractInput } from '@brainstrike/agent';
import { WEB_EXTRACT_TOOL_ID } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import { refuseExtractUrl } from './extract-url-refusal.js';

const logger = createLogger('AssistantWebExtractTool');

// Single source of truth lives in @brainstrike/assistant-contract so the
// desktop registry and every other consumer agree on the id.
export { refuseExtractUrl, WEB_EXTRACT_TOOL_ID };

// The same Tavily credential webSearch uses; Tavily /extract shares the account.

const DEFAULT_TIMEOUT_MS = 15_000;
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const UNAVAILABLE_MESSAGE =
  'Web extract is unavailable — add a Tavily API key in Settings → Providers → Other credentials to enable it.';

/** One extracted page returned to the model. */
export interface WebExtractResultItem {
  /** Complete markdown/plain content returned by Tavily. */
  content: string;
  /** The page URL. */
  url: string;
}

/** One URL that was refused locally or failed on the extraction service. */
export interface WebExtractFailedItem {
  reason: string;
  url: string;
}

export interface WebExtractToolResult {
  /**
   * False ONLY when no Tavily key is configured: a NON-FATAL signal that the
   * tool cannot run, never an error. True for both successful extractions and
   * extraction errors (see `error`).
   */
  available: boolean;
  /** Count of extracted pages in this response (results.length). */
  count: number;
  /**
   * Present on a NON-FATAL request failure (network error, timeout, non-OK
   * Tavily response). The run continues; the model should tell the user.
   */
  error?: string;
  /** URLs refused by the local guard or failed by the extraction service. */
  failed: WebExtractFailedItem[];
  /** Reserved for actionable guidance on a future explicitly partial result. */
  hint?: string;
  /** Actionable next step / context message (e.g. the "add a key" guidance). */
  message?: string;
  /** Complete extracted pages; oversized output settles through the artifact store. */
  results: WebExtractResultItem[];
  truncated: boolean;
}

/** Injectable dependencies so tests stay hermetic (no real network/keychain). */
export interface WebExtractToolDependencies {
  /** The fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Resolves the Tavily API key (env first, then the process's credential
   * store). Returns undefined when unset. Each process supplies its own owner.
   */
  resolveApiKey: () => Promise<string | undefined>;
  /** Network timeout in ms (default 15000 — extraction is slower than search). */
  timeoutMs?: number;
}

/** Shape of the Tavily `/extract` response we consume (other fields ignored). */
interface TavilyExtractApiResponse {
  // biome-ignore lint/style/useNamingConvention: Tavily API wire field
  failed_results?: Array<{ url?: unknown; error?: unknown }>;
  // biome-ignore lint/style/useNamingConvention: Tavily API wire field
  results?: Array<{ url?: unknown; raw_content?: unknown }>;
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Split model-supplied URLs into guard-accepted ones and per-URL refusals. */
function partitionExtractUrls(urls: readonly string[]): {
  accepted: string[];
  failed: WebExtractFailedItem[];
} {
  const accepted: string[] = [];
  const failed: WebExtractFailedItem[] = [];
  for (const url of urls) {
    const refusal = refuseExtractUrl(url);
    if (refusal) {
      failed.push({ reason: refusal, url });
    } else {
      accepted.push(url);
    }
  }
  return { accepted, failed };
}

/** Normalize Tavily's /extract payload without losing source or failure bytes. */
function normalizeExtractPayload(
  payload: TavilyExtractApiResponse,
  failed: WebExtractFailedItem[]
): WebExtractResultItem[] {
  const items = (Array.isArray(payload.results) ? payload.results : [])
    .map(
      (entry): WebExtractResultItem => ({
        content: coerceString(entry?.raw_content),
        url: coerceString(entry?.url),
      })
    )
    .filter((item) => item.url.length > 0);
  for (const failure of Array.isArray(payload.failed_results) ? payload.failed_results : []) {
    const url = coerceString(failure?.url);
    if (url.length > 0) {
      failed.push({ reason: coerceString(failure?.error) || 'extraction failed', url });
    }
  }
  return items;
}

/**
 * Extract readable page content via Tavily's /extract endpoint.
 *
 * NO-SILENT-FALLBACKS (same contract as webSearch):
 * - No key configured → a NON-FATAL `{ available: false, ... }` result with an
 *   actionable message (never a thrown error).
 * - Guard-refused URLs → reported per-URL in `failed` with the reason, never
 *   silently dropped; nothing refused is ever sent to Tavily.
 * - Network error / timeout / non-OK response → a NON-FATAL
 *   `{ available: true, error, results: [] }` result, logged.
 *
 * The Tavily key is resolved server-side and used only to authenticate the
 * request; it is never returned in the result. Logs carry no URLs or key.
 */
export async function runWebExtract(
  input: WebExtractInput,
  dependencies: WebExtractToolDependencies
): Promise<WebExtractToolResult> {
  const resolveApiKey = dependencies.resolveApiKey;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate EVERY url before touching the key or the network so a fully
  // refused call never burns quota and internal URLs never leave the machine.
  const { accepted: acceptedUrls, failed } = partitionExtractUrls(input.urls);
  if (acceptedUrls.length === 0) {
    logger.info('webExtract refused all requested URLs before any network call', {
      refusedCount: failed.length,
    });
    return {
      available: true,
      count: 0,
      failed,
      results: [],
      truncated: false,
    };
  }

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    logger.info('webExtract requested without a configured Tavily key');
    return {
      available: false,
      count: 0,
      failed,
      message: UNAVAILABLE_MESSAGE,
      results: [],
      truncated: false,
    };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(TAVILY_EXTRACT_URL, {
      body: JSON.stringify({ urls: acceptedUrls }),
      headers: {
        // Bearer auth keeps the key out of the URL/query string.
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal,
    });

    if (!response.ok) {
      const errorText = `Tavily extract failed with HTTP ${response.status}.`;
      // Never include the API key, response auth headers, or URLs in logs.
      logger.error('webExtract Tavily response not ok', { status: response.status });
      return {
        available: true,
        count: 0,
        error: errorText,
        failed,
        results: [],
        truncated: false,
      };
    }

    const payload = (await response.json()) as TavilyExtractApiResponse;
    const items = normalizeExtractPayload(payload, failed);
    return {
      available: true,
      count: items.length,
      failed,
      results: items,
      truncated: false,
    };
  } catch (error) {
    // AbortSignal.timeout uses TimeoutError; some runtimes/fetch paths still
    // surface AbortError. Treat both as the non-fatal timeout result.
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const errorText = timedOut
      ? `Tavily extract timed out after ${timeoutMs}ms.`
      : 'Tavily extract failed due to a network error.';
    logger.error('webExtract failed', { aborted: timedOut, error });
    return {
      available: true,
      count: 0,
      error: errorText,
      failed,
      results: [],
      truncated: false,
    };
  }
}
