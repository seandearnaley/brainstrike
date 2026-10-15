/**
 * The RETIRED Mastra agent-loop entry, kept for the desktop/test callers that
 * still drive it directly.
 *
 * It lives here rather than in `message-utils.ts` because importing it pulls
 * the whole 98-file engine closure: while it sat beside the pure message
 * converters, `hosted-web.ts` could not export those converters without
 * dragging the loop into every traced Vercel function (ADR-0022).
 */
import type { AgentMessage, RuntimeData, StreamIterator } from '../types';
import { injectWorkspaceRootManifestContext } from '../workspace-root-manifest';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import { streamMastraAgent } from './agent-streaming';

// Adapter to Vercel AI SDK v5 style data stream if needed by routes
export async function toAiSdkStyleStream(
  messages: AgentMessage[],
  runtime?: RuntimeData,
  optionsOverride: Pick<
    MastraAgentRuntimeOptions,
    // authInput rides the OPTIONS (a direct parameter), never RuntimeData —
    // see the BST-1352 threading rule on MastraAgentRuntimeOptions.authInput.
    | 'authInput'
    | 'mcpHost'
    | 'mcpTaskTracking'
    | 'memory'
    | 'storage'
    | 'toolOutputArtifactInlineMaxSerializedCharsByToolName'
    | 'toolOutputArtifactStore'
  > = {}
): Promise<StreamIterator> {
  const options: MastraAgentRuntimeOptions = { ...optionsOverride };
  if (runtime) {
    options.runtime = runtime;
  }
  if (runtime?.model) {
    options.model = runtime.model;
  }
  if (runtime?.mcpConfig) {
    options.mcpConfig = runtime.mcpConfig;
  }
  if (runtime?.mastraTools) {
    options.tools = runtime.mastraTools;
  }
  if (runtime?.personas) {
    options.personas = runtime.personas;
  }

  const messagesWithRootManifest = injectWorkspaceRootManifestContext(messages, runtime);
  const streamMessages = runtime?.memory
    ? selectCurrentTurnMessages(messagesWithRootManifest)
    : messagesWithRootManifest;
  return streamMastraAgent(streamMessages, options);
}

function selectCurrentTurnMessages(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      const systemMessages = messages
        .slice(0, index)
        .filter((message) => message.role === 'system');
      return [...systemMessages, ...messages.slice(index)];
    }
  }
  throw new Error('Mastra memory requires a current user message');
}
