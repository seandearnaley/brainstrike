import type {
  GatewayLanguageModel,
  MastraModelGatewayInterface,
  ProviderConfig,
} from '@mastra/core/llm';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { getProviderEnvKeys } from './registry';

/**
 * OpenRouter strict-content compatibility (2026-08-16 field failure).
 *
 * Mastra's model-router serializes assistant chat messages as
 * `content: text || null`, so a replayed assistant turn that produced only
 * tool calls (reasoning + tool-call parts, no text) reaches the wire as
 * `"content": null`. That is valid for OpenAI, but Alibaba's DashScope —
 * the upstream OpenRouter routes `qwen/*` to — rejects the entire request:
 * `invalid_parameter_error: The content field is a required field.`
 *
 * The coercion (`null` → `""`) matches what LiteLLM applies and what
 * pydantic-ai proposed for the same upstream (pydantic/pydantic-ai#5287).
 * It is deliberately scoped to model families whose host enforces string
 * content: OpenRouter re-normalizes messages for Anthropic-style upstreams
 * where an injected empty text block would itself be invalid, so a blanket
 * rewrite is NOT safe.
 *
 * Upstream fix belongs in @openrouter/ai-sdk-provider's
 * convert-to-openrouter-chat-messages (still `text || null` on main as of
 * 2026-08-16); until it lands, this gateway resolves the same provider
 * version Mastra bundles (2.10.0, pinned in the workspace catalog) with a
 * request-normalizing fetch.
 */

const OPENROUTER_ROUTER_PREFIX = 'openrouter/';
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Model-id prefixes whose primary OpenRouter host requires assistant
 * `content` to be a string. Extend when another upstream exhibits the same
 * validation (each addition needs a captured provider error to cite).
 */
const STRICT_CONTENT_MODEL_PREFIXES: readonly string[] = ['qwen/'];

export function openRouterModelRequiresStringContent(modelId: string): boolean {
  return STRICT_CONTENT_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeStrictContentBody(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed['model'] !== 'string' ||
    !openRouterModelRequiresStringContent(parsed['model']) ||
    !Array.isArray(parsed['messages'])
  ) {
    return;
  }
  let changed = false;
  const messages = parsed['messages'].map((message) => {
    if (
      isRecord(message) &&
      message['role'] === 'assistant' &&
      (message['content'] === null || message['content'] === undefined)
    ) {
      changed = true;
      return { ...message, content: '' };
    }
    return message;
  });
  if (!changed) {
    return;
  }
  return { ...init, body: JSON.stringify({ ...parsed, messages }) };
}

/**
 * Wrap a fetch so `/chat/completions` bodies bound for strict-content models
 * never carry `content: null` on assistant messages. Everything else passes
 * through byte-identical. The base fetch is resolved at call time so test
 * stubs of `globalThis.fetch` are honored.
 */
export function createOpenRouterStrictContentFetch(baseFetch?: typeof fetch): typeof fetch {
  return (input, init) => {
    const resolvedFetch = baseFetch ?? globalThis.fetch;
    return resolvedFetch(input, normalizeStrictContentBody(init) ?? init);
  };
}

/**
 * Custom Mastra model-router gateway claiming ONLY the `openrouter/*` router
 * ids whose model family needs the strict-content coercion (`qwen/*`). Every
 * other OpenRouter model falls through to Mastra's own models.dev gateway
 * untouched, so this PR-sized blast radius is exactly the models that 400
 * without it.
 *
 * Resolution parity with the built-in models.dev gateway is deliberate:
 * same provider package + version (guarded by
 * `scripts/__tests__/openrouter-provider-mirror-contract.test.mjs`), same
 * base URL (`OPENROUTER_BASE_URL` env override honored), same missing-auth
 * phrasing — the only delta is the strict-content fetch, pinned by the
 * request-equivalence spec. Everything else the router does
 * (explicit-credential precedence, sampling-param stripping keyed by router
 * id) is unchanged because the router class itself is unchanged.
 *
 * Key resolution (BST-1361): the provider factory threads the request's
 * already-resolved credential through the constructor, so a key sourced from
 * `BRAINSTRIKE_OPENROUTER_API_KEY` or the stored keychain reaches the
 * gateway exactly like an `OPENROUTER_API_KEY` one. The residual env
 * fallback (Mastra-initiated getApiKey calls with no threaded key) derives
 * its names from the provider registry — never a hardcoded single name.
 */
export class OpenRouterStrictContentGateway implements MastraModelGatewayInterface {
  readonly id = 'brainstrike-openrouter';
  readonly name = 'Brainstrike OpenRouter strict-content gateway';
  private readonly resolvedApiKey: string | undefined;

  constructor(resolvedApiKey?: string) {
    const trimmed = resolvedApiKey?.trim();
    this.resolvedApiKey = trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  handlesModel(modelId: string): boolean {
    if (!modelId.startsWith(OPENROUTER_ROUTER_PREFIX)) {
      return false;
    }
    return openRouterModelRequiresStringContent(modelId.slice(OPENROUTER_ROUTER_PREFIX.length));
  }

  fetchProviders(): Promise<Record<string, ProviderConfig>> {
    // The models.dev registry still owns catalog listings for OpenRouter;
    // this gateway only claims model resolution.
    return Promise.resolve({});
  }

  buildUrl(_modelId: string, envVars: Record<string, string | undefined>): string {
    return envVars['OPENROUTER_BASE_URL'] || OPENROUTER_DEFAULT_BASE_URL;
  }

  getApiKey(modelId: string): Promise<string> {
    if (this.resolvedApiKey) {
      return Promise.resolve(this.resolvedApiKey);
    }
    const envNames = getProviderEnvKeys('openrouter');
    for (const envName of envNames) {
      const value = process.env[envName]?.trim();
      if (value) {
        return Promise.resolve(value);
      }
    }
    // Phrasing matters: GatewayManager classifies /Could not find API key/i
    // as an expected missing-auth state for catalog checks, not a failure.
    return Promise.reject(
      new Error(`Could not find API key (checked ${envNames.join(', ')}) for model id ${modelId}`)
    );
  }

  resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    const provider = createOpenRouter({
      apiKey: args.apiKey,
      baseURL: this.buildUrl(args.modelId, process.env),
      ...(args.headers ? { headers: args.headers } : {}),
      fetch: createOpenRouterStrictContentFetch(),
    });
    // The npm package is the exact provider version Mastra bundles for its
    // own openrouter resolution, so the runtime stream shape (including
    // providerMetadata cost accounting) is identical; only the declared
    // @ai-sdk type lineage differs, hence the cast. The provider CALLABLE
    // (not `.chat()`) is required for parity: it dispatches
    // `openai/gpt-3.5-turbo-instruct` to the completion model.
    return provider(args.modelId) as unknown as GatewayLanguageModel;
  }
}
