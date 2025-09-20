import type ElectronStore from 'electron-store';
import { describe, expect, it, vi } from 'vitest';
import { createSecretsService } from '../../secrets';

// Mock electron safeStorage
vi.mock('electron', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => {
        // mock encryption: prefix and encode
        return Buffer.from(encoder.encode(`enc:${s}`));
      },
      decryptString: (b: Buffer) => {
        const text = decoder.decode(b);
        return text.replace(/^enc:/, '');
      },
    },
  };
});

describe('secrets service', () => {
  it('encrypts, persists and decrypts keys per provider', async () => {
    const backing: Record<string, unknown> = {};
    const mockStore = {
      get: vi.fn((key: string) => backing[key]),
      set: vi.fn((key: string, value: unknown) => {
        backing[key] = value;
      }),
    } as unknown as ElectronStore<{ secrets: Record<string, string> }>;

    const svc = createSecretsService(mockStore);
    expect(await svc.listProviders()).toEqual([]);

    // Save key
    const ok = await svc.saveKey('openai', 'sk-123');
    expect(ok).toBe(true);
    // Listing should reflect provider
    expect(await svc.listProviders()).toEqual(['openai']);

    // Retrieve
    const val = await svc.getKey('openai');
    expect(val).toBe('sk-123');

    // Delete
    const del = await svc.deleteKey('openai');
    expect(del).toBe(true);
    expect(await svc.getKey('openai')).toBeNull();
  });
});
