import { getAssistantBridge } from '@brainstrike/assistant-contract';
import { resolveAssistantAuthHeaders } from '@brainstrike/assistant-data';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';

export function canRefreshAgentColors(): boolean {
  const bridge = getAssistantBridge();
  return typeof bridge?.getAuth === 'function' && typeof bridge?.getUrl === 'function';
}

export async function refreshAgentColors(
  rootThreadId: string,
  ownerResourceId: string
): Promise<number> {
  if (!canRefreshAgentColors()) {
    throw new Error('Agent color refresh is unavailable in this workspace.');
  }
  const [baseUrl, authHeaders] = await Promise.all([
    resolveAssistantBaseUrl(),
    resolveAssistantAuthHeaders(),
  ]);
  const response = await fetch(`${baseUrl}/assistant/refresh-agent-colors`, {
    body: JSON.stringify({ ownerResourceId, rootThreadId }),
    headers: { ...authHeaders, 'content-type': 'application/json' },
    method: 'POST',
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error(
      response.ok
        ? 'Agent color refresh returned an invalid response.'
        : `Agent colors could not be refreshed (HTTP ${response.status}).`,
      { cause }
    );
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'Agent colors could not be refreshed.';
    throw new Error(message);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('changed' in body) ||
    typeof body.changed !== 'number' ||
    !Number.isSafeInteger(body.changed) ||
    body.changed < 0
  ) {
    throw new Error('Agent color refresh returned an invalid result.');
  }
  return body.changed;
}
