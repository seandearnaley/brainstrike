import {
  type AgentMessage,
  createProvider,
  injectWorkspaceRootManifestContext,
  materializeHostProviderModel,
  type ProviderAuthInput,
  type RuntimeData,
  type StreamChunk,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import type { ResolvedProviderCredential } from '@brainstrike/assistant-service/ports';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';

/**
 * Build a stateless Hosted Web stream (BST-973-2 converged entry, ADR-0022).
 *
 * One AI SDK 7 `streamText` call, no agent loop. Vercel may move consecutive
 * requests across function instances, so nothing here may own session state or
 * continuation replay. The Web runtime exposes no tool registry, no memory and
 * no storage: approval/suspend actions are rejected by the HTTP boundary before
 * this function is called, and the allow-list
 * (`web-assistant-runtime-schema.ts`) is what keeps every other stateful field
 * off the wire.
 *
 * The runtime arrives ALREADY TRUSTED — the allow-list pre-filter ran before
 * the shared prepareAssistantPostRequest, which stamped the provider. This
 * function only re-attaches the key and request signal; re-validating here
 * would double-run the boundary.
 */
export async function buildWebAssistantStreamFromPrepared(params: {
  readonly agentMessages: AgentMessage[];
  /**
   * The typed credential the shared preparation resolved (BST-1352 review
   * finding 6): web is a PROJECTION of it, never a parallel string re-mint.
   * api_key-only enforcement lives at the web resolution layer
   * (runWebAssistantPost's env-backed reader), so this is always an api_key
   * credential when present.
   */
  readonly credential: ResolvedProviderCredential | undefined;
  /** The turn returns each completed step, for a client that records its runs (BST-1940). */
  readonly recordSteps?: boolean;
  readonly runtimeData: RuntimeData;
  readonly signal?: AbortSignal;
}): Promise<AsyncIterable<StreamChunk>> {
  const provider =
    typeof params.runtimeData.provider === 'string' ? params.runtimeData.provider : '';
  // Rides the model construction as a direct parameter, never RuntimeData.
  const authInput: ProviderAuthInput | undefined = providerAuthInputFromCredential(
    provider,
    params.credential
  );
  const runtime: RuntimeData = {
    ...params.runtimeData,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  // The workspace root manifest is a prompt preamble derived from the
  // allow-listed workspace fields; it is engine-independent and still runs.
  const messages = injectWorkspaceRootManifestContext(params.agentMessages, runtime);
  // No model argument: Hosted Web owns model policy server-side, so the
  // provider's registry default is the model, exactly as before ADR-0022.
  const model = materializeHostProviderModel(
    createProvider(provider, authInput, undefined, runtime)
  );
  return await streamHostedWebTurn({
    messages,
    model,
    ...(params.recordSteps ? { recordSteps: true } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
