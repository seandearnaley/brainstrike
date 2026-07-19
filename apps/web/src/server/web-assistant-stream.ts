import {
  type AgentMessage,
  type StreamChunk,
  toAiSdkStyleStream,
} from '@brainstrike/agent/hosted-web';
import { resolveWebAssistantRuntime } from './web-assistant-runtime';

/**
 * Build a stateless Hosted Web stream.
 *
 * Vercel may move consecutive requests across function instances, so module
 * state cannot own Mastra workflow snapshots or continuation replay. The Web
 * runtime also exposes no tool registry. Approval/suspend actions are rejected
 * by the HTTP boundary before this function is called; normal turns therefore
 * run without a storage argument and cannot accidentally advertise persistence.
 */
export async function buildWebAssistantStream(params: {
  readonly agentMessages: AgentMessage[];
  readonly data: unknown;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}): Promise<AsyncIterable<StreamChunk>> {
  const runtime = resolveWebAssistantRuntime(params.data, params.apiKey, params.signal);
  return await toAiSdkStyleStream(params.agentMessages, runtime);
}
