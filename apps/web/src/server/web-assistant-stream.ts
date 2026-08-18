import {
  type AgentMessage,
  type ProviderAuthInput,
  type RuntimeData,
  type StreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent/hosted-web';
import type { ResolvedProviderCredential } from '@brainstrike/assistant-service/ports';
import { providerAuthInputFromCredential } from '@brainstrike/assistant-service/provider-credential-projection';

/**
 * Build a stateless Hosted Web stream (BST-973-2 converged entry).
 *
 * Vercel may move consecutive requests across function instances, so module
 * state cannot own Mastra workflow snapshots or continuation replay. The Web
 * runtime also exposes no tool registry. Approval/suspend actions are rejected
 * by the HTTP boundary before this function is called; normal turns therefore
 * run without a storage argument and cannot accidentally advertise persistence.
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
  readonly runtimeData: RuntimeData;
  readonly signal?: AbortSignal;
}): Promise<AsyncIterable<StreamChunk>> {
  // Rides the STREAM OPTIONS as a direct parameter, never RuntimeData —
  // RuntimeData reaches Mastra RequestContext serialization (BST-1352).
  const provider =
    typeof params.runtimeData.provider === 'string' ? params.runtimeData.provider : '';
  const authInput: ProviderAuthInput | undefined = providerAuthInputFromCredential(
    provider,
    params.credential
  );
  return await toAiSdkStyleStream(
    params.agentMessages,
    {
      ...params.runtimeData,
      ...(params.signal ? { signal: params.signal } : {}),
    },
    authInput ? { authInput } : {}
  );
}
