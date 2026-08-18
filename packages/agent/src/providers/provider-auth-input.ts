/**
 * ProviderAuthInput (BST-1352): the discriminated auth seam consumed by
 * `createProvider`. It replaces the bare `apiKey?: string` parameter so future
 * auth flows plug into the factory without new string side channels:
 *
 * - `api_key` — the existing bearer-key flow, behavior-identical to the old
 *   string argument. Every current caller uses this kind.
 * - `custom_fetch` — an injected `fetch` threaded into the AI SDK `create*`
 *   factories (consumed by BST-1356, e.g. OAuth token refresh in the fetch
 *   closure). The `apiKey` is a dummy the wire never trusts; the fetch closure
 *   owns real authentication. Provider cases whose model config has NO fetch
 *   seam (Mastra descriptor configs: openrouter/ollama/lmstudio, and the local
 *   host client) throw a typed error rather than silently dropping the fetch.
 * - `aws` — SigV4/Bedrock-shaped input (consumed by BST-1350/BST-1353).
 *   Validated here (region is required) but consumed by NO provider case yet;
 *   every case throws a typed error until the Bedrock provider lands.
 *
 * THREADING RULE (do not relitigate): auth inputs travel as DIRECT function
 * parameters the whole way down (runAssistantTurn → initializeAgentStream →
 * stream options → resolveRuntimeConfiguration → createProvider). They NEVER
 * enter RuntimeData or a Mastra RequestContext — RequestContext.toJSON drops
 * functions, so a fetch closure would vanish silently.
 */
import { createMastraAgentError } from '../mastra/mastra-agent-error';

export type ProviderAuthInput =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'custom_fetch'; apiKey: string /* dummy, never sent */; fetch: typeof globalThis.fetch }
  | {
      kind: 'aws';
      region: string;
      apiKey?: string;
      /** Typed when BST-1353 adds the AWS credential-provider dependency. */
      credentialProvider?: unknown;
    };

/**
 * Validate an auth input's own shape before any provider dispatch. Only `aws`
 * carries cross-field requirements today (a region is mandatory — an empty
 * region is a malformed input, not a default-region request).
 */
export function assertValidProviderAuthInput(auth: ProviderAuthInput | undefined): void {
  if (auth === undefined) {
    return;
  }
  switch (auth.kind) {
    case 'api_key':
    case 'custom_fetch':
      return;
    case 'aws':
      if (!auth.region.trim()) {
        throw createMastraAgentError('mastra_agent_runtime_init_failed', {
          context: { authKind: 'aws' },
          detail: 'aws auth input requires a region.',
        });
      }
      return;
    default:
      assertNeverAuthInput(auth);
  }
}

export interface ProviderFetchOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Project an auth input onto the AI SDK `create*` factory options
 * (`{ apiKey?, fetch? }`). Generic on purpose: ANY provider case built on an
 * AI SDK factory consumes this helper unchanged. `aws` has no bearer/fetch
 * projection — it throws typed until BST-1350/BST-1353 add a consumer.
 */
export function providerFetchOptions(
  auth: ProviderAuthInput | undefined,
  provider: string
): ProviderFetchOptions {
  if (auth === undefined) {
    return {};
  }
  switch (auth.kind) {
    case 'api_key':
      // Empty string keeps the old `apiKey ? { apiKey } : undefined` behavior:
      // no key option, SDK-side env resolution untouched.
      return auth.apiKey ? { apiKey: auth.apiKey } : {};
    case 'custom_fetch':
      return { apiKey: auth.apiKey, fetch: auth.fetch };
    case 'aws':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'aws', provider },
        detail: `Provider "${provider}" does not consume aws auth input yet (BST-1350/BST-1353).`,
      });
    default:
      return assertNeverAuthInput(auth);
  }
}

/**
 * Narrow an auth input to the bearer-key-only surface for provider cases whose
 * model config is a Mastra DESCRIPTOR (openrouter/ollama/lmstudio) or the
 * local host client — configs with no fetch seam at all. `custom_fetch` and
 * `aws` throw typed here: dropping the fetch (or the AWS credentials) and
 * proceeding on the dummy/absent key would be a silent auth downgrade.
 */
export function bearerApiKeyOnly(
  auth: ProviderAuthInput | undefined,
  provider: string
): string | undefined {
  if (auth === undefined) {
    return;
  }
  switch (auth.kind) {
    case 'api_key':
      return auth.apiKey;
    case 'custom_fetch':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'custom_fetch', provider },
        detail: `Provider "${provider}" has no fetch seam and cannot accept custom_fetch auth input.`,
      });
    case 'aws':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'aws', provider },
        detail: `Provider "${provider}" does not consume aws auth input yet (BST-1350/BST-1353).`,
      });
    default:
      return assertNeverAuthInput(auth);
  }
}

/**
 * Wrap a legacy resolved key string as an `api_key` auth input. The ONE
 * string→union adapter for callers that still resolve bearer keys (persistent
 * memory, persona pin key maps); `undefined` stays `undefined`.
 */
export function apiKeyAuthInput(apiKey: string | undefined): ProviderAuthInput | undefined {
  return apiKey === undefined ? undefined : { apiKey, kind: 'api_key' };
}

/**
 * Compile-time exhaustiveness for every ProviderAuthInput switch — exported
 * so the union's other switch sites (runtime-configuration) share ONE
 * unreachable-arm handler instead of hand-rolling their own.
 */
export function assertNeverAuthInput(auth: never): never {
  throw createMastraAgentError('mastra_agent_runtime_init_failed', {
    detail: `Unhandled provider auth input kind: ${String((auth as { kind?: unknown }).kind)}.`,
  });
}
