import { listProviders } from '@brainstrike/assistant-contract/provider-registry';
import { describe, expect, it } from 'vitest';
import {
  HOSTED_WEB_ASSISTANT_PROVIDERS,
  isHostedWebAssistantProvider,
} from '../server/assistant-config';

/**
 * Hosted Web must never offer a subscription-OAuth provider — BST-1356, legal
 * gate BST-1351 constraints 2 and 4.
 *
 * Constraint 2 forbids server-side proxying of subscription traffic, and
 * constraint 4 makes the provider structurally unavailable outside interactive
 * desktop sessions. Hosted Web is a server: it has no OS keychain, no
 * `shell.openExternal`, and no interactive window, and a shared deployment
 * serving many users is precisely the ban-risk pattern the gate names.
 *
 * This is asserted over the AUTH TYPE rather than a hardcoded id so a future
 * subscription provider (Copilot, SuperGrok) cannot be added to Hosted Web
 * without this test failing.
 */

describe('hosted web assistant providers', () => {
  it('excludes the ChatGPT-subscription provider', () => {
    expect(HOSTED_WEB_ASSISTANT_PROVIDERS).not.toContain('openai-codex');
    expect(isHostedWebAssistantProvider('openai-codex')).toBe(false);
  });

  it('excludes EVERY oauth_subscription provider, now and later', () => {
    const subscriptionProviders = listProviders()
      .filter((provider) => provider.authType === 'oauth_subscription')
      .map((provider) => provider.id);

    // Guard the guard: if this is empty the assertion below proves nothing.
    expect(subscriptionProviders.length).toBeGreaterThan(0);

    for (const providerId of subscriptionProviders) {
      expect(
        isHostedWebAssistantProvider(providerId),
        `${providerId} uses subscription auth and must not be served by Hosted Web`
      ).toBe(false);
    }
  });

  it('serves only api_key providers', () => {
    const byId = new Map(listProviders().map((provider) => [provider.id, provider]));
    for (const providerId of HOSTED_WEB_ASSISTANT_PROVIDERS) {
      expect(byId.get(providerId)?.authType, `${providerId} authType`).toBe('api_key');
    }
  });
});
