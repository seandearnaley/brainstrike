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
  MastraAgentRuntimeOptions,
  ProviderAuthInput,
  RuntimeData,
} from '@brainstrike/agent';
import type { LocalLlmHostClient } from '@brainstrike/agent/local-llm';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import type { AgentStreamResult } from './types.js';

type LocalLlmGenerateArgs = Parameters<LocalLlmHostClient['generate']>;
type LocalLlmWarmupArgs = Parameters<LocalLlmHostClient['warmup']>;

type SerializableIndependentStreamRuntimeOptions = Pick<
  MastraAgentRuntimeOptions,
  | 'conversationBinding'
  | 'memory'
  | 'storage'
  | 'toolOutputArtifactInlineMaxSerializedCharsByToolName'
  | 'toolOutputArtifactStore'
>;

export interface AssistantStreamRuntimeOptions extends SerializableIndependentStreamRuntimeOptions {
  /**
   * Provider auth travels as a direct stream option, never through RuntimeData
   * or RequestContext: custom_fetch may contain a closure, which serialization
   * would silently discard.
   */
  authInput?: ProviderAuthInput;
  /** Live-run MCP Apps admission observer; process-local like `mcpHost`. */
  mcpAppAdmission?: NonNullable<MastraAgentRuntimeOptions['mcpAppAdmission']>;
  /**
   * The live host object graph is process-local and cannot survive request
   * serialization. Hosts inject it directly at the stream boundary.
   */
  mcpHost?: NonNullable<MastraAgentRuntimeOptions['mcpHost']>;
  /** Trusted host task authorities (BST-1566); process-local like `mcpHost`. */
  mcpTaskTracking?: NonNullable<MastraAgentRuntimeOptions['mcpTaskTracking']>;
}

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

// The concrete projections over these reader types (the string migration shim
// and the factory auth-input projection) live in
// ./provider-credential-projection — ports.ts stays a structural surface.

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
