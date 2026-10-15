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
 * - `aws` — Bedrock-shaped input: a region plus EXACTLY ONE credential form,
 *   a bearer key (BST-1350) or an AWS credential-chain provider (BST-1353).
 *   Validated here (region required, bearer XOR chain) and consumed ONLY by
 *   the `bedrock` provider case via `requireAwsAuthInput`; every other case
 *   throws a typed error.
 *
 * THREADING RULE (do not relitigate): auth inputs travel as DIRECT function
 * parameters the whole way down (stream options → resolveRuntimeConfiguration
 * → createProvider). They NEVER
 * enter RuntimeData or a Mastra RequestContext — RequestContext.toJSON drops
 * functions, so a fetch closure would vanish silently.
 */
import { isValidAwsRegion } from '@brainstrike/assistant-contract';
import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import type { AwsCredentialIdentityProvider } from './aws-credential-identity';

/**
 * Actionable missing-region guidance (BST-1350). One string for every seam
 * that rejects a region-less Bedrock request — a missing region is a typed
 * init failure, never a silent default region.
 */
export const MISSING_AWS_REGION_DETAIL =
  'Amazon Bedrock requires an AWS region and none was resolved. Configure an AWS region for Bedrock in Settings (stored with the key), or set AWS_REGION when using an environment bearer key.';

/**
 * SECURITY (PR #2522 review, finding 1): the region is interpolated into the
 * Bedrock request hostname, so a non-region value (e.g. `evil.example.com/`)
 * would exfiltrate the bearer token and prompt content. The message stays
 * STATIC — the (attacker-controllable) value is never echoed.
 */
export const INVALID_AWS_REGION_DETAIL =
  'The configured AWS region is not a valid AWS region identifier (expected a value like "us-east-1"). Fix the region for Bedrock in Settings or in AWS_REGION.';

/**
 * EXACTLY-ONE credential requirement (PR #2522 finding 4, widened by
 * BST-1353). An aws input must carry a bearer key OR a credential provider.
 *
 * Neither is a typed failure rather than a shrug: with both absent the AI SDK
 * silently falls back to AMBIENT AWS environment credentials, so a
 * misconfigured request would quietly sign with whatever identity happens to
 * be in the process env. Credential-chain auth is opt-in and EXPLICIT — it
 * arrives as a constructed `credentialProvider`, never as an ambient default.
 */
export const MISSING_AWS_CREDENTIALS_DETAIL =
  'Amazon Bedrock requires either a Bedrock API key (bearer token) or an AWS profile/credential-chain provider, and neither was resolved. Configure a Bedrock credential in Settings.';

/**
 * BOTH forms supplied. Ambiguous auth is never resolved by preferring one:
 * precedence between bearer and chain is decided ONCE, at credential
 * resolution (apps/desktop/src/provider-api-key.ts), so a doubly-populated
 * input reaching the factory means a resolver bug — surfaced, not papered
 * over.
 */
export const CONFLICTING_AWS_CREDENTIALS_DETAIL =
  'Amazon Bedrock received BOTH a bearer key and an AWS credential-chain provider. Exactly one auth form is valid per request; credential resolution must pick the winner before the factory.';

export type ProviderAuthInput =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'custom_fetch'; apiKey: string /* dummy, never sent */; fetch: typeof globalThis.fetch }
  | {
      kind: 'aws';
      region: string;
      apiKey?: string;
      /**
       * The AWS default credential chain (BST-1353), built per request by
       * `createAwsCredentialChain`. Typed through the IMPORT-FREE identity
       * module so this browser-reachable seam keeps zero edges — type-only
       * included — to the Node-only `@aws-sdk/credential-providers`.
       *
       * NEVER SERIALIZED: this is a closure, and `RequestContext.toJSON`
       * drops functions. It rides the DIRECT-parameter threading rule with
       * the rest of the union (see the header note), so it can never vanish
       * silently into runtime data.
       */
      credentialProvider?: AwsCredentialIdentityProvider;
    };

/**
 * Validate an auth input's own shape before any provider dispatch. Only `aws`
 * carries cross-field requirements: a region is mandatory (an empty region is
 * a malformed input, not a default-region request), and EXACTLY ONE of
 * `apiKey` / `credentialProvider` must be present (BST-1353) — neither would
 * silently sign with ambient env credentials, both would be ambiguous.
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
          detail: MISSING_AWS_REGION_DETAIL,
        });
      }
      if (!isValidAwsRegion(auth.region)) {
        throw createMastraAgentError('mastra_agent_runtime_init_failed', {
          context: { authKind: 'aws' },
          detail: INVALID_AWS_REGION_DETAIL,
        });
      }
      assertExactlyOneAwsCredential(auth);
      return;
    default:
      assertNeverAuthInput(auth);
  }
}

/**
 * The bearer-XOR-chain rule (BST-1353). Enforced HERE, before provider
 * dispatch, so it fails identically no matter which provider case is reached
 * — the same placement the region rules use.
 */
export function assertExactlyOneAwsCredential(
  auth: Extract<ProviderAuthInput, { kind: 'aws' }>
): void {
  const hasBearer = Boolean(auth.apiKey);
  const hasChain = auth.credentialProvider !== undefined;
  if (hasBearer && hasChain) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { authKind: 'aws' },
      detail: CONFLICTING_AWS_CREDENTIALS_DETAIL,
    });
  }
  if (!(hasBearer || hasChain)) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { authKind: 'aws' },
      detail: MISSING_AWS_CREDENTIALS_DETAIL,
    });
  }
}

export interface ProviderFetchOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Project an auth input onto the AI SDK `create*` factory options
 * (`{ apiKey?, fetch? }`). Generic on purpose: ANY provider case built on an
 * AI SDK factory consumes this helper unchanged. `aws` projects its bearer
 * key ONLY for providers whose registry authType is `'aws'` (bedrock,
 * BST-1350) — on any other provider it throws typed, because silently
 * reusing a Bedrock bearer as e.g. an OpenAI api key would be a credential
 * confusion, not a projection.
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
      if (findProviderDefinition(provider)?.authType === 'aws') {
        return auth.apiKey ? { apiKey: auth.apiKey } : {};
      }
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'aws', provider },
        detail: `Only aws-authType providers consume aws auth input (BST-1350); provider "${provider}" cannot.`,
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
        detail: `Provider "${provider}" is not an aws-authType provider and cannot consume aws auth input (BST-1350).`,
      });
    default:
      return assertNeverAuthInput(auth);
  }
}

/**
 * Narrow an auth input to the `aws` kind for the Bedrock provider case
 * (BST-1350). Everything else fails typed:
 *
 * - absent auth and `api_key` both carry NO region, so they get the
 *   actionable missing-region guidance (a bearer key alone cannot build a
 *   Bedrock client — region is mandatory, never defaulted);
 * - `custom_fetch` has no consumer on the Bedrock case and must never be
 *   silently dropped.
 */
export function requireAwsAuthInput(
  auth: ProviderAuthInput | undefined,
  provider: string
): Extract<ProviderAuthInput, { kind: 'aws' }> {
  if (auth === undefined) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { provider },
      detail: MISSING_AWS_REGION_DETAIL,
    });
  }
  switch (auth.kind) {
    case 'aws':
      return auth;
    case 'api_key':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'api_key', provider },
        detail: MISSING_AWS_REGION_DETAIL,
      });
    case 'custom_fetch':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'custom_fetch', provider },
        detail: `Provider "${provider}" does not consume custom_fetch auth input.`,
      });
    default:
      return assertNeverAuthInput(auth);
  }
}

/**
 * Narrow an auth input to the `custom_fetch` kind for provider cases whose
 * authentication lives ENTIRELY in the fetch closure (BST-1356, the
 * ChatGPT-subscription provider). Everything else fails typed:
 *
 * - `api_key` would send a platform API key to the subscription backend — a
 *   credential confusion, and one that could bill the user's metered account
 *   for traffic they asked to draw on their subscription.
 * - `aws` has no meaning here.
 * - absent auth means the provider is not connected; there is no ambient
 *   fallback for OAuth, and inventing one would defeat the interactive-only
 *   gate (legal gate BST-1351, constraint 4).
 */
export function requireCustomFetchAuthInput(
  auth: ProviderAuthInput | undefined,
  provider: string
): Extract<ProviderAuthInput, { kind: 'custom_fetch' }> {
  if (auth === undefined) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { provider },
      detail: `Provider "${provider}" requires a connected subscription credential and none was resolved. Connect the account in Settings.`,
    });
  }
  switch (auth.kind) {
    case 'custom_fetch':
      return auth;
    case 'api_key':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'api_key', provider },
        detail: `Provider "${provider}" authenticates with a subscription OAuth session, not an API key.`,
      });
    case 'aws':
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { authKind: 'aws', provider },
        detail: `Provider "${provider}" does not consume aws auth input.`,
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
