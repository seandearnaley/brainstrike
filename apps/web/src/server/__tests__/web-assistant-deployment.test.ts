import { describe, expect, it } from 'vitest';
import {
  resolveWebAssistantDeploymentAccess,
  WEB_ASSISTANT_PRODUCTION_DISABLED_REASON,
} from '../web-assistant-deployment';

describe('Web assistant deployment access', () => {
  it('enables the server-key endpoint only for Vercel previews', () => {
    expect(resolveWebAssistantDeploymentAccess('preview')).toEqual({ enabled: true });
  });

  it.each([
    undefined,
    '',
    'production',
    'development',
    'staging',
  ])('fails closed outside a Vercel preview for %s', (vercelEnvironment) => {
    expect(resolveWebAssistantDeploymentAccess(vercelEnvironment)).toEqual({
      enabled: false,
      reason: WEB_ASSISTANT_PRODUCTION_DISABLED_REASON,
    });
  });
});
