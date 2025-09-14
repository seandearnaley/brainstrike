import * as electron from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecryptionToEnv,
  applyDecryptionToHeaders,
  withDecryptedSecrets,
} from '../../mcp-loader';

describe('mcp-loader helpers', () => {
  // In tests, decryptIfEncrypted falls back to base64 decoding when safeStorage is unavailable.
  // We still set up a spy if safeStorage exists, otherwise proceed without it.
  const electronWithSafeStorage = electron as typeof electron & {
    safeStorage?: { decryptString: (buffer: Buffer) => string };
  };
  const decryptSpy = electronWithSafeStorage.safeStorage
    ? vi.spyOn(electronWithSafeStorage.safeStorage, 'decryptString')
    : ({ mockImplementation: vi.fn() } as ReturnType<typeof vi.spyOn>);

  beforeEach(() => {
    decryptSpy.mockImplementation((buf: Buffer) => {
      try {
        return Buffer.from(buf).toString('utf-8');
      } catch {
        return 'decrypted';
      }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decrypts Encrypted headers', () => {
    const res = applyDecryptionToHeaders({
      AuthorizationEncrypted: Buffer.from('abc').toString('base64'),
    });
    expect(res?.['Authorization']).toBe('abc');
  });

  it('decrypts Encrypted env', () => {
    const res = applyDecryptionToEnv({ TOKENEncrypted: Buffer.from('xyz').toString('base64') });
    expect(res?.['TOKEN']).toBe('xyz');
  });

  it('applies decryption across servers', () => {
    const cfg = withDecryptedSecrets({
      servers: [
        {
          name: 'web',
          transport: 'sse',
          url: 'http://localhost',
          headers: { AuthorizationEncrypted: Buffer.from('def').toString('base64') },
        },
        {
          name: 'fs',
          transport: 'stdio',
          command: 'node',
          env: { SECRETEncrypted: Buffer.from('123').toString('base64') },
        },
      ],
    });
    const web = cfg.servers[0];
    const fs = cfg.servers[1];
    if (web && 'headers' in web) {
      expect(
        (web as Extract<typeof web, { headers: Record<string, string> }>).headers['Authorization']
      ).toBe('def');
    }
    if (fs && 'env' in fs) {
      expect((fs as Extract<typeof fs, { env: Record<string, string> }>).env['SECRET']).toBe('123');
    }
  });
});
