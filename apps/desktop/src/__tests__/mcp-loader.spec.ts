import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  'electron',
  () =>
    ({
      app: { getPath: () => '/tmp' },
      safeStorage: {
        decryptString: (buf: Buffer) => `dec:${buf.toString('utf-8')}`,
        isEncryptionAvailable: () => true,
      },
    }) as unknown as typeof import('electron')
);

import { applyDecryptionToEnv, applyDecryptionToHeaders } from '../mcp-loader';

describe('mcp-loader decryption helpers', () => {
  beforeEach(() => {
    // no-op; isolated per test
  });

  it('decrypts *Encrypted header keys into plain keys and preserves others', () => {
    const headers = applyDecryptionToHeaders({
      AuthorizationEncrypted: Buffer.from('sek').toString('base64'),
      'X-Trace': 'on',
    });

    expect(headers).toMatchObject({
      Authorization: expect.stringContaining('dec:'),
      'X-Trace': 'on',
    });
    // original encrypted suffix should not remain
    expect(Object.keys(headers || {})).not.toContain('AuthorizationEncrypted');
  });

  it('decrypts *Encrypted env vars into plain keys and preserves others', () => {
    const env = applyDecryptionToEnv({
      API_KEYEncrypted: Buffer.from('abc').toString('base64'),
      NODE_ENV: 'test',
    });
    expect(env).toMatchObject({ API_KEY: expect.stringContaining('dec:'), NODE_ENV: 'test' });
    expect(Object.keys(env || {})).not.toContain('API_KEYEncrypted');
  });

  // Note: Node's base64 decoder does not always throw on malformed input,
  // so we don't assert behavior for invalid input here.
});
