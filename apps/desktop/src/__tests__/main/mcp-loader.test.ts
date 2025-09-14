import * as electron from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecryptionToEnv,
  applyDecryptionToHeaders,
  type McpServer,
  withDecryptedSecrets,
} from '../../mcp-loader';

describe('mcp-loader helpers', () => {
  // Set up spy only when Electron safeStorage is available in this environment.
  const electronWithSafeStorage = electron as typeof electron & {
    safeStorage?: { decryptString: (buffer: Buffer) => string };
  };
  // Mock spy for decryptString function
  let decryptSpy: typeof vi.spyOn | null = null;

  beforeEach(() => {
    if (electronWithSafeStorage.safeStorage) {
      // @ts-expect-error - Complex Vitest spy typing, using explicit cast for test simplicity
      decryptSpy = vi.spyOn(electronWithSafeStorage.safeStorage, 'decryptString');
      // @ts-expect-error - Test mock implementation with simplified typing
      decryptSpy?.mockImplementation((buf: Buffer) => {
        try {
          return Buffer.from(buf).toString('utf-8');
        } catch {
          return 'decrypted';
        }
      });
    } else {
      decryptSpy = null;
    }
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
    const web = cfg.servers[0] as Extract<McpServer, { transport: 'sse' }>;
    const fs = cfg.servers[1] as Extract<McpServer, { transport: 'stdio' }>;
    if (web?.headers) {
      expect(web.headers['Authorization']).toBe('def');
    }
    if (fs?.env) {
      expect(fs.env['SECRET']).toBe('123');
    }
  });
});
