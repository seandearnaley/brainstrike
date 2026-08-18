/**
 * Host-supplied ports for the transport-independent assistant run service
 * (BST-972 slice B1). This file grows one port per slice; each is a STRUCTURAL
 * surface a host satisfies — never a desktop import.
 *
 * InferenceHostPort: proxies built-in local-LLM generation to wherever the
 * host runs inference (desktop: the hidden llm-host renderer via
 * LlmHostManager — inference is renderer-only per the LOCAL LLM ARCHITECTURE
 * rules). The shapes are derived from `@brainstrike/agent/local-llm`'s own
 * client contract, so the port names no host types: desktop's `LlmHostManager`
 * satisfies it structurally (the pre-B1 `Pick<LlmHostManager, ...>` alias
 * asserted the same compatibility from the desktop side).
 */
import type {
  AgentMessage,
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  ProviderAuthInput,
  RuntimeData,
} from '@brainstrike/agent';
import type { LocalLlmHostClient } from '@brainstrike/agent/local-llm';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import type { AgentStreamResult } from './types.js';

type LocalLlmGenerateArgs = Parameters<LocalLlmHostClient['generate']>;
type LocalLlmWarmupArgs = Parameters<LocalLlmHostClient['warmup']>;

export interface AssistantLlmHostManager {
  generateForMain(
    request: {
      messages: LocalLlmGenerateArgs[0]['messages'];
      modelId: LocalLlmGenerateArgs[0]['modelId'];
      options?: LocalLlmGenerateArgs[0]['options'];
    },
    options: NonNullable<LocalLlmGenerateArgs[1]>
  ): ReturnType<LocalLlmHostClient['generate']>;
  warmupForMain(
    modelId: LocalLlmWarmupArgs[0],
    options: NonNullable<LocalLlmWarmupArgs[1]>
  ): ReturnType<LocalLlmHostClient['warmup']>;
}

/**
 * Adapt an InferenceHostPort manager to the agent package's
 * `LocalLlmHostClient` (moved verbatim from the desktop's
 * local-llm-host-client.ts; the injection seam that lets provider 'local' run
 * inside the real Mastra loop — memory, run events, tool guards — while
 * inference stays wherever the host put it).
 */
export function createMainLlmHostClient(manager: AssistantLlmHostManager): LocalLlmHostClient {
  return {
    generate: (request, options = {}) =>
      manager.generateForMain(
        {
          messages: request.messages,
          modelId: request.modelId,
          ...(request.options ? { options: request.options } : {}),
        },
        options
      ),
    warmup: (modelId, options = {}) => manager.warmupForMain(modelId, options),
  };
}

/**
 * CredentialPort reader (BST-972 B2): resolve a provider's API key, returning
 * undefined for not-configured and THROWING the host's secret-read failure
 * for unreadable (classified structurally via
 * @brainstrike/assistant-contract's matchSecretReadError — see
 * ./secret-errors). Since BST-1352 this is the MIGRATION shim over
 * {@link ProviderCredentialReader}; new code consumes the typed reader and
 * hosts derive this string surface via {@link createProviderApiKeyReader}.
 */
export type ProviderApiKeyReader = (provider: string) => Promise<string | undefined>;

/**
 * A resolved typed credential (BST-1352): the BST-1348 union plus where it
 * came from. `source: 'env'` entries are always `api_key` (environment
 * variables can only express bearer keys); typed `oauth`/`aws` credentials
 * only ever arrive with `source: 'stored'`.
 */
export type ResolvedProviderCredential = ProviderCredential & { source: 'env' | 'stored' };

/**
 * Typed CredentialPort reader (BST-1352): same contract as
 * {@link ProviderApiKeyReader} — `undefined` for not-configured, THROW the
 * host's secret-read failure for unreadable — but the resolved value is the
 * full typed credential. Desktop passes provider-credentials'
 * `resolveProviderCredential`; Hosted Web adapts its env-only config lookup
 * into `api_key` credentials.
 */
export type ProviderCredentialReader = (
  provider: string
) => Promise<ResolvedProviderCredential | undefined>;

/**
 * A typed credential reached a consumer that can only use bearer-key strings.
 * Deliberately SHAPED like the desktop `SecretReadError`
 * (name/code/provider/message — the matchSecretReadError structural contract,
 * message text included) so every existing secret-error responder classifies
 * it as the same `api_key_unreadable` wire failure the desktop `getKey` path
 * produced for stored non-api_key credentials. The credential itself is NEVER
 * stringified or echoed.
 */
export class UnsupportedCredentialTypeError extends Error {
  readonly code = 'credential_type_unsupported';
  readonly provider: string;

  constructor(provider: string) {
    super(
      `Secret for "${provider}" is unreadable: stored credential uses a newer auth flow; ` +
        're-enter an API key or reconnect the provider. Re-enter the key to repair it.'
    );
    // matchSecretReadError matches structurally on this name (BST-972 A3).
    this.name = 'SecretReadError';
    this.provider = provider;
  }
}

/**
 * The ONE typed→string compatibility adapter (BST-1352 migration shim):
 * presents a {@link ProviderCredentialReader} as the legacy string
 * {@link ProviderApiKeyReader}. `api_key` credentials project to `.key`; ANY
 * other credential type throws {@link UnsupportedCredentialTypeError} — a
 * structured credential is never stringified.
 */
export function createProviderApiKeyReader(
  readCredential: ProviderCredentialReader
): ProviderApiKeyReader {
  return async (provider: string): Promise<string | undefined> => {
    const credential = await readCredential(provider);
    if (credential === undefined) {
      return;
    }
    if (credential.type !== 'api_key') {
      throw new UnsupportedCredentialTypeError(provider);
    }
    return credential.key;
  };
}

/**
 * Project a resolved credential onto a factory auth input (BST-1352). Only
 * `api_key` credentials have a projection today — `custom_fetch` is minted by
 * its consumer (BST-1356) and `aws` credential mapping lands with
 * BST-1350/BST-1353. A non-api_key credential never reaches this helper in
 * the current pipeline (resolveCredentialOrReject rejects it first); if one
 * does, that is a wiring bug and it fails loudly.
 */
export function providerAuthInputFromCredential(
  provider: string,
  credential: ResolvedProviderCredential | undefined
): ProviderAuthInput | undefined {
  if (credential === undefined) {
    return;
  }
  if (credential.type !== 'api_key') {
    throw new UnsupportedCredentialTypeError(provider);
  }
  return { apiKey: credential.key, kind: 'api_key' };
}

/**
 * Stream-initializer capability (BST-972 B3): produce the turn's
 * AgentStreamResult from the prepared request core. Injected so
 * runAssistantTurn moves BEFORE the initializer implementation does — the
 * desktop composes agent-stream-init (with its MCP-config load, tool floor,
 * and memory factory closed over) until B4 moves that engine too.
 */
export type StreamInitializer = (params: {
  readonly apiKey: string | undefined;
  /**
   * Provider auth input (BST-1352), threaded as a DIRECT parameter end to end
   * (runAssistantTurn → initializer → stream options). NEVER placed on
   * `runtimeData`/RequestContext — toJSON drops functions, so a custom_fetch
   * closure would vanish silently.
   */
  readonly authInput?: ProviderAuthInput | undefined;
  readonly messages: AgentMessage[];
  readonly runId: string | undefined;
  readonly runtimeData: RuntimeData;
  readonly signal: AbortSignal;
  readonly toolApprovalAction?: AssistantToolApprovalAction | undefined;
  readonly toolResumeAction?: AssistantToolResumeAction | undefined;
}) => Promise<AgentStreamResult>;

/**
 * RunPersistencePort (partial, BST-972 B3): terminal run-row status. The
 * desktop adapter is run-persistence.ts's recordDesktopAssistantThreadRunStatus
 * with db-main's getDatabase closed over; failures are logged there, never
 * thrown (the write is bookkeeping relative to the served turn).
 *
 * PROVENANCE RULE (docs/agents/assistant-persistence.md, settled 2026-07-24 —
 * carried onto this port deliberately): the run relations are created ONLY by
 * the renderer's bootstrap, and holding a runId implies they exist because
 * repository.createThreadRun is the sole minting site. ANY new producer that
 * mints runIds — an in-process caller of this service is exactly the "second
 * producer" hazard that section names — must guarantee that schema bootstrap
 * itself before its first write.
 */
export interface RunPersistencePort {
  readonly recordThreadRunStatus: (
    runId: string,
    status: 'cancelled' | 'completed' | 'failed',
    error: string | null
  ) => Promise<void>;
}
