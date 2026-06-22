import type { WebSearchInput } from '@brainstrike/agent';
import { fitItemsToCharBudget } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import { getSecretsService } from '../secrets';

const logger = createLogger('AssistantWebSearchTool');

export const WEB_SEARCH_TOOL_ID = 'brainstrike.webSearch' as const;

/**
 * The secrets-store provider id under which the Tavily API key is stored. NOT a
 * `ProviderId` (Tavily is not an LLM/embedding provider, so it stays out of the
 * model registry); the secrets service keys by arbitrary string, so we reuse
 * that same encrypted-keychain path without polluting `ProviderId`.
 */
export const TAVILY_SECRET_PROVIDER = 'tavily' as const;

/** Env vars consulted before the encrypted keychain (env takes priority). */
const TAVILY_ENV_KEYS = ['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY'] as const;

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
/** Hard cap on each snippet so one verbose result cannot dominate the budget. */
const MAX_SNIPPET_CHARS = 600;

const UNAVAILABLE_MESSAGE =
  'Web search is unavailable — add a Tavily API key in Settings → API Keys to enable it.';

/** One normalized search hit returned to the model. */
export interface WebSearchResultItem {
  /** Bounded snippet/content excerpt for the result. */
  snippet: string;
  /** Result title. */
  title: string;
  /** Result URL. */
  url: string;
}

export interface WebSearchToolResult {
  /**
   * False ONLY when no Tavily key is configured: a NON-FATAL signal that the
   * tool cannot run, never an error. True for both successful searches and
   * search errors (see `error`).
   */
  available: boolean;
  /** Count of results in this response (results.length). */
  count: number;
  /**
   * Present on a NON-FATAL search failure (network error, timeout, non-OK
   * Tavily response). The run continues; the model should tell the user.
   */
  error?: string;
  /** Actionable hint when the result list was truncated to fit the budget. */
  hint?: string;
  /** Actionable next step / context message (e.g. the "add a key" guidance). */
  message?: string;
  /** The search query that was issued (echoed for the model's context). */
  query: string;
  /** Results returned, self-bounded to the tool output budget. */
  results: WebSearchResultItem[];
  /** Total results Tavily returned before budget trimming. */
  totalResults: number;
  truncated: boolean;
}

/** Injectable dependencies so tests stay hermetic (no real network/keychain). */
export interface WebSearchToolDependencies {
  /** The fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Resolves the Tavily API key (env → keychain). Returns undefined when unset. */
  resolveApiKey?: () => Promise<string | undefined>;
  /** Network timeout in ms (default 10000). */
  timeoutMs?: number;
}

/** Shape of the Tavily `/search` response we consume (other fields ignored). */
interface TavilyApiResponse {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
  }>;
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

/**
 * Resolve the Tavily key server-side ONLY: env vars first, then the encrypted
 * keychain via {@link getSecretsService}. The key is never returned to the
 * model or the renderer — it is used solely to authenticate the Tavily request
 * inside this main-process tool.
 */
async function resolveTavilyApiKeyFromKeychain(): Promise<string | undefined> {
  const envKey = readTavilyEnvKey();
  if (envKey) {
    return envKey;
  }
  const stored = await getSecretsService().getKey(TAVILY_SECRET_PROVIDER);
  const normalized = typeof stored === 'string' ? stored.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundSnippet(content: string): string {
  if (content.length <= MAX_SNIPPET_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_SNIPPET_CHARS)}…`;
}

function normalizeResults(response: TavilyApiResponse): WebSearchResultItem[] {
  const raw = Array.isArray(response.results) ? response.results : [];
  return raw
    .map((entry): WebSearchResultItem => {
      const url = coerceString(entry?.url);
      const title = coerceString(entry?.title) || url || 'Untitled result';
      return {
        title,
        url,
        snippet: boundSnippet(coerceString(entry?.content)),
      };
    })
    .filter((item) => item.url.length > 0);
}

function buildBudgetedResult(args: {
  query: string;
  items: readonly WebSearchResultItem[];
}): WebSearchToolResult {
  const { query, items } = args;
  const totalResults = items.length;
  // Build the hint INSIDE the fitted candidate so it can never push the
  // serialized result back over the budget (mirrors globWorkspace/grepSearch).
  const { result } = fitItemsToCharBudget(items, (kept): WebSearchToolResult => {
    const truncated = kept.length < totalResults;
    const hint = truncated
      ? `Showing ${kept.length} of ${totalResults} results (trimmed to fit the tool output budget). Refine the query or lower maxResults to see the most relevant hits.`
      : undefined;
    return {
      available: true,
      query,
      results: kept.slice(),
      count: kept.length,
      totalResults,
      truncated,
      ...(hint ? { hint } : {}),
    };
  });
  return result;
}

/**
 * Execute a Tavily web search.
 *
 * NO-SILENT-FALLBACKS:
 * - No key configured → a NON-FATAL `{ available: false, ... }` result with an
 *   actionable message (never a thrown error, never a faked search).
 * - Network error / timeout / non-OK response → a NON-FATAL
 *   `{ available: true, error, results: [] }` result, logged, so the run
 *   continues and the model can report the failure honestly.
 *
 * The Tavily key is resolved server-side and used only to authenticate the
 * request; it is never returned in the result.
 */
export async function runWebSearch(
  input: WebSearchInput,
  dependencies: WebSearchToolDependencies = {}
): Promise<WebSearchToolResult> {
  const query = input.query.trim();
  const maxResults = Math.min(input.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
  const resolveApiKey = dependencies.resolveApiKey ?? resolveTavilyApiKeyFromKeychain;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The schema `.min(2)` validates the RAW length, but we trim — so a
  // whitespace-only query (e.g. "   ") passes validation yet becomes empty
  // here. Short-circuit BEFORE resolving the key or touching the network so a
  // no-op query never burns a Tavily quota credit. Non-fatal (the run
  // continues): the model just gets told to issue a real query.
  if (query.length === 0) {
    logger.info('webSearch requested with an empty query; skipping network call');
    return {
      available: true,
      query,
      error: 'Empty search query.',
      results: [],
      count: 0,
      totalResults: 0,
      truncated: false,
    };
  }

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    logger.info('webSearch requested without a configured Tavily key', { query });
    return {
      available: false,
      query,
      message: UNAVAILABLE_MESSAGE,
      results: [],
      count: 0,
      totalResults: 0,
      truncated: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Bearer auth keeps the key out of the URL/query string.
        authorization: `Bearer ${apiKey}`,
      },
      // The Tavily REST API requires snake_case request fields; these are the
      // external service's wire contract, not our naming.
      body: JSON.stringify({
        query,
        // biome-ignore lint/style/useNamingConvention: Tavily API wire field
        max_results: maxResults,
        // biome-ignore lint/style/useNamingConvention: Tavily API wire field
        search_depth: 'basic',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = `Tavily search failed with HTTP ${response.status}.`;
      // Never include the API key or response auth headers in logs.
      logger.error('webSearch Tavily response not ok', { status: response.status, query });
      return {
        available: true,
        query,
        error: errorText,
        results: [],
        count: 0,
        totalResults: 0,
        truncated: false,
      };
    }

    const payload = (await response.json()) as TavilyApiResponse;
    const normalized = normalizeResults(payload).slice(0, maxResults);
    return buildBudgetedResult({ query, items: normalized });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const errorText = aborted
      ? `Tavily search timed out after ${timeoutMs}ms.`
      : 'Tavily search failed due to a network error.';
    logger.error('webSearch failed', { error, query, aborted });
    return {
      available: true,
      query,
      error: errorText,
      results: [],
      count: 0,
      totalResults: 0,
      truncated: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}
