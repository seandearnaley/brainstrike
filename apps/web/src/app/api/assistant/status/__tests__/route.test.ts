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
    resolveHostedWebAssistantStatus: vi.fn(),
  };
});

import { resolveHostedWebAssistantStatus } from '../../../../../server/assistant-config';
import { GET } from '../route';

describe('assistant status route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns every configured provider and safe credential source', async () => {
    vi.mocked(resolveHostedWebAssistantStatus).mockReturnValue({
      enabled: true,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      providerKeySources: [
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
        { envVar: 'OPENROUTER_API_KEY', provider: 'openrouter', source: 'env' },
      ],
      providers: ['anthropic', 'openrouter'],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({
      enabled: true,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      providerKeySources: [
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
        { envVar: 'OPENROUTER_API_KEY', provider: 'openrouter', source: 'env' },
      ],
      providers: ['anthropic', 'openrouter'],
    });
  });

  it('returns disabled status with reason when missing key', async () => {
    vi.mocked(resolveHostedWebAssistantStatus).mockReturnValue({
      enabled: false,
      reason: 'missing_api_key',
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
    vi.mocked(resolveHostedWebAssistantStatus).mockReturnValue({
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
      providers: ['openai'],
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
