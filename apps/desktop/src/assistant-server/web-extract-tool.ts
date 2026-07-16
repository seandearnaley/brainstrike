import type { WebExtractInput } from '@brainstrike/agent';
import { fitItemsToCharBudget, WEB_EXTRACT_TOOL_ID } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { getSecretsService } from '../secrets';
import { TAVILY_SECRET_PROVIDER } from './web-search-tool';

const logger = createLogger('AssistantWebExtractTool');

// Single source of truth lives in @brainstrike/assistant-contract so the
// desktop registry and every other consumer agree on the id.
export { WEB_EXTRACT_TOOL_ID };

/** Env vars consulted before the encrypted keychain (env takes priority) —
 * the SAME key webSearch uses; Tavily /extract shares the account. */
const TAVILY_ENV_KEYS = ['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY'] as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
/** Hard cap per extracted page so one long article cannot dominate the budget. */
const MAX_CONTENT_CHARS_PER_PAGE = 6000;

const UNAVAILABLE_MESSAGE =
  'Web extract is unavailable — add a Tavily API key in Settings → API Keys to enable it.';

/** One extracted page returned to the model. */
export interface WebExtractResultItem {
  /** Bounded markdown/plain content of the page. */
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
  /** Actionable hint when content was trimmed to fit the budget. */
  hint?: string;
  /** Actionable next step / context message (e.g. the "add a key" guidance). */
  message?: string;
  /** Extracted pages, self-bounded to the tool output budget. */
  results: WebExtractResultItem[];
  truncated: boolean;
}

/** Injectable dependencies so tests stay hermetic (no real network/keychain). */
export interface WebExtractToolDependencies {
  /** The fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Resolves the Tavily API key (env → keychain). Returns undefined when unset. */
  resolveApiKey?: () => Promise<string | undefined>;
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

function readTavilyEnvKey(): string | undefined {
  for (const envKey of TAVILY_ENV_KEYS) {
    const value = process.env[envKey];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return;
}

/** Env first, then the encrypted keychain — resolved server-side ONLY (the key
 * authenticates the Tavily request and is never returned to model/renderer). */
async function resolveTavilyApiKeyFromKeychain(): Promise<string | undefined> {
  const envKey = readTavilyEnvKey();
  if (envKey) {
    return envKey;
  }
  const stored = await getSecretsService().getKey(TAVILY_SECRET_PROVIDER);
  const normalized = typeof stored === 'string' ? stored.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

/** RFC1918/loopback/link-local IPv4 + unique-local/link-local/loopback IPv6. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  // IPv6 literals: loopback, unspecified, link-local fe80::/10, unique-local fc00::/7.
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^fe[89ab]/.test(host) || /^f[cd]/.test(host);
  }
  // IPv4 literals only — public HOSTNAMES are not DNS-resolved here (the fetch
  // happens on Tavily's servers, not this machine; the guard's job is to keep
  // clearly-internal URLs from ever being SENT to the external service).
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number) as [number, number, number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

/**
 * Validate one model-supplied URL BEFORE it is sent to the external service:
 * parseable, http/https only, no embedded credentials, no private/loopback/
 * link-local hosts. Returns the refusal reason, or null when acceptable.
 */
export function refuseExtractUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'invalid URL — must be an absolute http(s) URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `refused: protocol "${parsed.protocol}" is not allowed (http/https only)`;
  }
  if (parsed.username || parsed.password) {
    return 'refused: URLs with embedded credentials are never sent to the extraction service';
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return 'refused: private/loopback/link-local hosts are never sent to the extraction service';
  }
  return null;
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

/** Normalize Tavily's /extract payload: bounded page items + service-side failures. */
function normalizeExtractPayload(
  payload: TavilyExtractApiResponse,
  failed: WebExtractFailedItem[]
): WebExtractResultItem[] {
  const items = (Array.isArray(payload.results) ? payload.results : [])
    .map(
      (entry): WebExtractResultItem => ({
        content: boundContent(coerceString(entry?.raw_content)),
        url: coerceString(entry?.url),
      })
    )
    .filter((item) => item.url.length > 0);
  for (const failure of Array.isArray(payload.failed_results) ? payload.failed_results : []) {
    const url = coerceString(failure?.url);
    if (url.length > 0) {
      failed.push({
        reason: coerceString(failure?.error) || 'extraction failed',
        url,
      });
    }
  }
  return items;
}

function boundContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS_PER_PAGE) {
    return content;
  }
  return `${content.slice(0, MAX_CONTENT_CHARS_PER_PAGE)}…`;
}

function buildBudgetedResult(args: {
  failed: WebExtractFailedItem[];
  items: readonly WebExtractResultItem[];
}): WebExtractToolResult {
  const { failed, items } = args;
  const totalResults = items.length;
  // Build the hint INSIDE the fitted candidate so it can never push the
  // serialized result back over the budget (mirrors webSearch/grepSearch).
  const { result } = fitItemsToCharBudget(items, (kept): WebExtractToolResult => {
    const truncated = kept.length < totalResults;
    const hint = truncated
      ? `Showing ${kept.length} of ${totalResults} extracted pages (trimmed to fit the tool output budget). Re-call with fewer urls to read the rest.`
      : undefined;
    return {
      available: true,
      count: kept.length,
      failed,
      results: kept.slice(),
      truncated,
      ...(hint ? { hint } : {}),
    };
  });
  // Per-page bounding can still leave ALL pages over budget together; the
  // fitter keeps at least the honest empty shape. When every page was dropped
  // by the fitter, surface that as truncation with the hint, never an error.
  if (result.results.length === 0 && totalResults > 0 && !result.hint) {
    return {
      ...result,
      hint: 'Extracted content exceeded the tool output budget. Re-call with a single url.',
      truncated: true,
    };
  }
  return result;
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
  dependencies: WebExtractToolDependencies = {}
): Promise<WebExtractToolResult> {
  const resolveApiKey = dependencies.resolveApiKey ?? resolveTavilyApiKeyFromKeychain;
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
    return buildBudgetedResult({ failed, items });
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
