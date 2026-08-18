import {
  type AgentMessage,
  type RuntimeData,
  type StreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent/hosted-web';

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
   * Passed separately from runtimeData: the shared preparation returns hosted
   * keys top-level (only local-server tokens are hydrated INTO runtimeData),
   * so the stream runtime must re-attach it here.
   */
  readonly apiKey: string;
  readonly runtimeData: RuntimeData;
  readonly signal?: AbortSignal;
}): Promise<AsyncIterable<StreamChunk>> {
  return await toAiSdkStyleStream(
    params.agentMessages,
    {
      ...params.runtimeData,
      apiKey: params.apiKey,
      ...(params.signal ? { signal: params.signal } : {}),
    },
    // BST-1352 factory auth seam: web adapts via `kind: 'api_key'` only. The
    // auth input rides the STREAM OPTIONS (a direct parameter), never
    // RuntimeData; the runtimeData.apiKey attach above stays for the legacy
    // resolution surface.
    params.apiKey ? { authInput: { apiKey: params.apiKey, kind: 'api_key' } } : {}
  );
}
