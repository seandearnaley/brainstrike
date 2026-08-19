import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderVerification } from './provider-verification-client';
import { verifyProviderCredential } from './verify-provider-credential';

vi.mock('./provider-verification-client', () => ({
  fetchProviderVerification: vi.fn(),
}));

vi.mock('./hooks/use-assistant-availability', () => ({
  resolveAssistantAuthHeaders: async () => ({ 'x-test-auth': 'token' }),
  resolveAssistantBaseUrl: async () => 'http://127.0.0.1:51234',
}));

const snapshot = {
  freshness: 'live',
  result: { checkedAt: '2026-08-18T12:00:00.000Z', status: 'verified' },
} as const;

describe('verifyProviderCredential', () => {
  beforeEach(() => {
    vi.mocked(fetchProviderVerification).mockReset();
  });

  it('resolves the assistant transport before probing, and forwards the caller signal', async () => {
    vi.mocked(fetchProviderVerification).mockResolvedValue(snapshot);
    const controller = new AbortController();

    await expect(verifyProviderCredential('openai', controller.signal)).resolves.toEqual(snapshot);

    expect(fetchProviderVerification).toHaveBeenCalledTimes(1);
    expect(fetchProviderVerification).toHaveBeenCalledWith({
      authHeaders: { 'x-test-auth': 'token' },
      baseUrl: 'http://127.0.0.1:51234',
      providerId: 'openai',
      signal: controller.signal,
    });
  });

  it('propagates probe failures to the caller rather than swallowing them', async () => {
    vi.mocked(fetchProviderVerification).mockRejectedValue(
      new Error('No credential configured for provider "openai".')
    );

    await expect(verifyProviderCredential('openai', new AbortController().signal)).rejects.toThrow(
      'No credential configured for provider "openai".'
    );
  });
});
