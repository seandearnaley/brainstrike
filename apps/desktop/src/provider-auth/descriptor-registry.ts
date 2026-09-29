import type { OAuthProviderDescriptor } from '@brainstrike/assistant-contract';
import { ProviderAuthFlowError } from './errors';

/**
 * OAuth provider descriptor registry (BST-1355).
 *
 * SHIPS EMPTY in this ticket — the engine is provider-agnostic and no active
 * descriptors exist yet. BST-1356 registers the first real descriptor
 * (OpenAI Codex) at desktop-main startup; tests register fixtures and clear
 * them in teardown. An unknown provider is a typed, visible failure
 * (`unknown_provider`) — never a default descriptor.
 */

const descriptors = new Map<string, OAuthProviderDescriptor>();

export function registerOAuthProviderDescriptor(descriptor: OAuthProviderDescriptor): void {
  if (descriptors.has(descriptor.providerId)) {
    throw new Error(`OAuth provider descriptor already registered for "${descriptor.providerId}".`);
  }
  descriptors.set(descriptor.providerId, descriptor);
}

export function hasOAuthProviderDescriptor(providerId: string): boolean {
  return descriptors.has(providerId);
}

export function getOAuthProviderDescriptor(providerId: string): OAuthProviderDescriptor {
  const descriptor = descriptors.get(providerId);
  if (!descriptor) {
    throw new ProviderAuthFlowError(
      'unknown_provider',
      `No OAuth provider descriptor registered for "${providerId}".`
    );
  }
  return descriptor;
}

export function listOAuthProviderDescriptorIds(): string[] {
  return [...descriptors.keys()];
}

/** Test-only teardown so fixture registrations never leak across tests. */
export function clearOAuthProviderDescriptorsForTest(): void {
  descriptors.clear();
}
