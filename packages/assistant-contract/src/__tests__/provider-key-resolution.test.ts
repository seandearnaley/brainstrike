import { describe, expect, it, vi } from 'vitest';
import {
  resolveHostedProviderKey,
  SECRETS_CHANGED_EVENT_NAME,
} from '../provider-key-resolution.js';

const names = ['A_KEY', 'B_KEY'] as const;

describe('resolveHostedProviderKey', () => {
  it('is env-authoritative: first matching name in the first matching source wins', async () => {
    const readSecret = vi.fn().mockResolvedValue('secret-key');
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{ B_KEY: 'from-first-source' }, { A_KEY: 'from-second-source' }],
      readSecret,
    });

    expect(result).toEqual({ key: 'from-first-source', source: 'env' });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('trims env values and treats blanks and non-strings as absent', async () => {
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{ A_KEY: '   ', B_KEY: ' padded-key ' }],
    });
    expect(result).toEqual({ key: 'padded-key', source: 'env' });

    const nonString = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{ A_KEY: true as unknown as string }],
    });
    expect(nonString).toEqual({});
  });

  it('falls back to the secret store when no env key exists', async () => {
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{}, undefined],
      readSecret: () => Promise.resolve(' stored-key '),
    });
    expect(result).toEqual({ key: 'stored-key', source: 'secrets' });
  });

  it('captures a secret-store failure instead of throwing (BST-574 escape hatch)', async () => {
    const failure = new Error('decrypt failed');
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{}],
      readSecret: () => Promise.reject(failure),
    });
    expect(result.key).toBeUndefined();
    expect(result.secretReadError).toBe(failure);
  });

  it('never surfaces a secret failure when an env key exists', async () => {
    const readSecret = vi.fn().mockRejectedValue(new Error('unreachable'));
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [{ A_KEY: 'env-key' }],
      readSecret,
    });
    expect(result).toEqual({ key: 'env-key', source: 'env' });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('treats a throwing env source as absent and continues to the next source', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile env getter');
        },
      }
    ) as Record<string, string | undefined>;
    const result = await resolveHostedProviderKey({
      envKeyNames: names,
      envSources: [hostile, { A_KEY: 'good-key' }],
    });
    expect(result).toEqual({ key: 'good-key', source: 'env' });
  });

  it('resolves empty when nothing matches and no secret store exists', async () => {
    await expect(
      resolveHostedProviderKey({ envKeyNames: names, envSources: [{}] })
    ).resolves.toEqual({});
  });
});

describe('SECRETS_CHANGED_EVENT_NAME', () => {
  it('pins the cross-domain invalidation event name', () => {
    expect(SECRETS_CHANGED_EVENT_NAME).toBe('brainstrike:secrets-changed');
  });
});
