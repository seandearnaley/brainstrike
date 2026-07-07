import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../server/assistant-config', async () => {
  const actual = await vi.importActual<typeof import('../../../../../server/assistant-config')>(
    '../../../../../server/assistant-config'
  );
  return {
    ...actual,
    resolveAssistantProviderConfig: vi.fn(),
  };
});

import { resolveAssistantProviderConfig } from '../../../../../server/assistant-config';
import { GET } from '../route';

describe('assistant status route', () => {
  it('returns enabled status when provider is configured', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ enabled: true });
  });

  it('returns disabled status with reason when missing key', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: '',
      disabledReason: 'missing_api_key',
      enabled: false,
    });

    const res = await GET();
    const payload = await res.json();
    expect(payload).toEqual({ enabled: false, reason: 'missing_api_key' });
  });
});
