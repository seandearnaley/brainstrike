import {
  type OpenRouterModelMetadataSnapshot,
  parseOpenRouterModelMetadataSnapshot,
} from '@brainstrike/assistant-contract';

const MAX_VISIBLE_ERROR_CHARS = 300;

interface FetchOpenRouterModelMetadataOptions {
  readonly authHeaders: Record<string, string>;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly modelId: string;
  readonly signal: AbortSignal;
}

function resolveServerErrorMessage(payload: unknown, status: number): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)['message'] === 'string'
  ) {
    const message = (payload as Record<string, string>)['message']?.trim();
    if (message) {
      return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
    }
  }
  return `OpenRouter model metadata request failed with HTTP ${status}.`;
}

export async function fetchOpenRouterModelMetadata({
  authHeaders,
  baseUrl,
  fetchImpl = globalThis.fetch,
  modelId,
  signal,
}: FetchOpenRouterModelMetadataOptions): Promise<OpenRouterModelMetadataSnapshot> {
  const url = new URL('/assistant/openrouter-model', baseUrl);
  url.searchParams.set('model', modelId);
  const response = await fetchImpl(url.toString(), { headers: authHeaders, signal });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(resolveServerErrorMessage(payload, response.status));
  }
  const snapshot = parseOpenRouterModelMetadataSnapshot(payload);
  if (snapshot.metadata.id !== modelId) {
    throw new Error(
      `OpenRouter model metadata returned "${snapshot.metadata.id}" for expected model "${modelId}".`
    );
  }
  return snapshot;
}
