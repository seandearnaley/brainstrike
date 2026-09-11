import { resolveAssistantAuthHeaders } from '@brainstrike/assistant-data';
import type { DelegatedConversationNode } from '@brainstrike/db';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';

export async function sendDelegatedWorkspaceInput(
  node: DelegatedConversationNode,
  hostRunId: string,
  input: { readonly id: string; readonly text: string },
  signal: AbortSignal
): Promise<void> {
  const [baseUrl, headers] = await Promise.all([
    resolveAssistantBaseUrl(),
    resolveAssistantAuthHeaders(),
  ]);
  const response = await fetch(new URL('/assistant/child-input', baseUrl), {
    body: JSON.stringify({
      ...input,
      hostRunId,
      ownerResourceId: node.ownerResourceId,
      rootThreadId: node.rootThreadId,
      threadId: node.threadId,
    }),
    headers: { ...headers, 'Content-Type': 'application/json' },
    method: 'POST',
    signal,
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Child input was not confirmed (${response.status}); the server returned an unreadable acknowledgement.`
    );
  }
  if (!response.ok) {
    if (
      result &&
      typeof result === 'object' &&
      'message' in result &&
      typeof result.message === 'string'
    ) {
      throw new Error(result.message);
    }
    throw new Error(`Child input was not confirmed (${response.status}).`);
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !('accepted' in result) ||
    result.accepted !== true ||
    !('id' in result) ||
    result.id !== input.id ||
    !('threadId' in result) ||
    result.threadId !== node.threadId
  ) {
    throw new Error('Child input acknowledgement does not match this request.');
  }
}
