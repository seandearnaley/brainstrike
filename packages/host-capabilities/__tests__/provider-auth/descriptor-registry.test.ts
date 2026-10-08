import type { OAuthProviderDescriptor } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearOAuthProviderDescriptorsForTest,
  getOAuthProviderDescriptor,
  hasOAuthProviderDescriptor,
  listOAuthProviderDescriptorIds,
  registerOAuthProviderDescriptor,
} from '../../src/provider-auth/descriptor-registry.js';

function makeDescriptor(providerId: string): OAuthProviderDescriptor {
  return {
    authorizeUrl: 'https://provider.test/authorize',
    clientId: 'client-123',
    providerId,
    redirectPath: '/callback',
    redirectPort: 43_210,
    scopes: ['openid'],
    tokenUrl: 'https://provider.test/token',
  };
}

afterEach(() => {
  clearOAuthProviderDescriptorsForTest();
});

describe('OAuth provider descriptor registry', () => {
  it('ships EMPTY: no active descriptors are registered in BST-1355', () => {
    expect(listOAuthProviderDescriptorIds()).toEqual([]);
  });

  it('registers and resolves a descriptor', () => {
    registerOAuthProviderDescriptor(makeDescriptor('fake'));
    expect(hasOAuthProviderDescriptor('fake')).toBe(true);
    expect(getOAuthProviderDescriptor('fake').clientId).toBe('client-123');
    expect(listOAuthProviderDescriptorIds()).toEqual(['fake']);
  });

  it('throws a typed unknown_provider error for unregistered providers', () => {
    expect(() => getOAuthProviderDescriptor('nope')).toThrowError(
      expect.objectContaining({ code: 'unknown_provider' })
    );
  });

  it('rejects duplicate registrations instead of silently overwriting', () => {
    registerOAuthProviderDescriptor(makeDescriptor('fake'));
    expect(() => registerOAuthProviderDescriptor(makeDescriptor('fake'))).toThrow(/already/);
  });
});
