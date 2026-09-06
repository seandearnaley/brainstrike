import {
  type ProviderVerificationSnapshot,
  parseProviderVerificationSnapshot,
} from '@brainstrike/assistant-contract';

const MAX_VISIBLE_ERROR_CHARS = 300;

interface FetchProviderVerificationOptions {
  readonly authHeaders: Record<string, string>;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly providerId: string;
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
  return `Provider verification request failed with HTTP ${status}.`;
}

/**
 * BST-1357 renderer client for GET /assistant/verify-provider, mirroring
 * {@link fetchOpenRouterModelMetadata}'s shape. Sends ONLY the provider id —
 * credentials resolve inside desktop main — and validates the typed snapshot
 * before returning it. Consumed by the Provider Hub "Test connection" UI
 * (BST-1362/BST-1358).
 */
export async function fetchProviderVerification({
  authHeaders,
  baseUrl,
  fetchImpl = globalThis.fetch,
  providerId,
  signal,
}: FetchProviderVerificationOptions): Promise<ProviderVerificationSnapshot> {
  const url = new URL('/assistant/verify-provider', baseUrl);
  url.searchParams.set('provider', providerId);
  const response = await fetchImpl(url.toString(), { headers: authHeaders, signal });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(resolveServerErrorMessage(payload, response.status));
  }
  return parseProviderVerificationSnapshot(payload);
}
