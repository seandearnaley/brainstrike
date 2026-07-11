import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMocks = vi.hoisted(() => ({
  decryptString: vi.fn(),
  decryptStringAsync: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
  isAsyncEncryptionAvailable: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: safeStorageMocks,
}));

import { type McpConfig, withDecryptedSecrets } from '../../mcp-loader';

describe('MCP encrypted configuration values', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeStorageMocks.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  });

  it('decrypts valid values through the asynchronous safeStorage API', async () => {
    safeStorageMocks.isAsyncEncryptionAvailable.mockResolvedValue(true);
    safeStorageMocks.decryptStringAsync.mockResolvedValue({
      result: 'Bearer decrypted-token',
      shouldReEncrypt: false,
    });
    safeStorageMocks.decryptString.mockImplementation(() => {
      throw new Error('synchronous safeStorage must not be used');
    });
    const encrypted = Buffer.from('encrypted-by-safe-storage').toString('base64');

    const result = await withDecryptedSecrets({
      servers: [
        {
          headers: { AuthorizationEncrypted: encrypted },
          name: 'remote-api',
          transport: 'sse',
          url: 'https://example.com/sse',
        },
      ],
    });

    expect(result.servers[0]).toMatchObject({
      headers: { Authorization: 'Bearer decrypted-token' },
    });
    expect(safeStorageMocks.decryptStringAsync).toHaveBeenCalledWith(
      Buffer.from(encrypted, 'base64')
    );
    expect(safeStorageMocks.decryptString).not.toHaveBeenCalled();
  });

  it('rejects instead of decoding encrypted values when safeStorage is unavailable', async () => {
    safeStorageMocks.isAsyncEncryptionAvailable.mockResolvedValue(false);
    safeStorageMocks.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'));
    const encrypted = Buffer.from('must-not-become-plaintext').toString('base64');
    const config: McpConfig = {
      servers: [
        {
          headers: { AuthorizationEncrypted: encrypted },
          name: 'remote-api',
          transport: 'sse',
          url: 'https://example.com/sse',
        },
      ],
    };

    await expect(Promise.resolve().then(() => withDecryptedSecrets(config))).rejects.toThrow(
      'MCP server "remote-api" header "Authorization": safeStorage encryption is unavailable'
    );
    expect(safeStorageMocks.decryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorageMocks.decryptString).not.toHaveBeenCalled();
  });

  it('rejects the insecure Linux basic_text storage backend', async () => {
    safeStorageMocks.isAsyncEncryptionAvailable.mockResolvedValue(true);
    safeStorageMocks.getSelectedStorageBackend.mockReturnValue('basic_text');
    safeStorageMocks.decryptStringAsync.mockResolvedValue({
      result: 'must-not-be-used',
      shouldReEncrypt: false,
    });
    const encrypted = Buffer.from('opaque-ciphertext').toString('base64');

    await expect(
      Promise.resolve().then(() =>
        withDecryptedSecrets({
          servers: [
            {
              command: 'node',
              env: { API_KEYEncrypted: encrypted },
              name: 'local-tools',
              transport: 'stdio',
            },
          ],
        })
      )
    ).rejects.toThrow(
      'MCP server "local-tools" environment variable "API_KEY": safeStorage backend basic_text is insecure'
    );
    expect(safeStorageMocks.decryptStringAsync).not.toHaveBeenCalled();
  });

  it('rejects instead of returning ciphertext when safeStorage decryption fails', async () => {
    safeStorageMocks.isAsyncEncryptionAvailable.mockResolvedValue(true);
    safeStorageMocks.decryptStringAsync.mockRejectedValue(new Error('keychain is locked'));
    safeStorageMocks.decryptString.mockImplementation(() => {
      throw new Error('legacy decryption failed');
    });
    const encrypted = Buffer.from('opaque-ciphertext').toString('base64');
    const config: McpConfig = {
      servers: [
        {
          command: 'node',
          env: { API_KEYEncrypted: encrypted },
          name: 'local-tools',
          transport: 'stdio',
        },
      ],
    };

    await expect(Promise.resolve().then(() => withDecryptedSecrets(config))).rejects.toThrow(
      'MCP server "local-tools" environment variable "API_KEY": keychain is locked'
    );
    expect(safeStorageMocks.decryptString).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['malformed', '!!!!'],
  ])('rejects %s encrypted values before safeStorage decryption', async (_label, encrypted) => {
    safeStorageMocks.isAsyncEncryptionAvailable.mockResolvedValue(true);
    safeStorageMocks.decryptStringAsync.mockResolvedValue({
      result: '',
      shouldReEncrypt: false,
    });

    await expect(
      withDecryptedSecrets({
        servers: [
          {
            command: 'node',
            env: { API_KEYEncrypted: encrypted },
            name: 'local-tools',
            transport: 'stdio',
          },
        ],
      })
    ).rejects.toThrow(
      'MCP server "local-tools" environment variable "API_KEY": ciphertext must be non-empty canonical base64'
    );
    expect(safeStorageMocks.decryptStringAsync).not.toHaveBeenCalled();
  });
});
