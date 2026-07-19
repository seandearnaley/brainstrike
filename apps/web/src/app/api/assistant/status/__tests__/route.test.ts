import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '@brainstrike/agent/request-boundary';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns enabled status when provider is configured', async () => {
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
    });
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

  it.each([
    ['malformed', 'secret-looking-invalid-value'],
    ['above the Hosted Web ceiling', String(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1)],
  ])('returns a stable disabled reason when the body limit is %s', async (_, configuredValue) => {
    vi.stubEnv(ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR, configuredValue);
    vi.mocked(resolveAssistantProviderConfig).mockReturnValue({
      apiKey: 'test-key',
      enabled: true,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({
      enabled: false,
      reason: 'invalid_request_body_limit_config',
    });
    expect(JSON.stringify(payload)).not.toContain(configuredValue);
  });
});
