import { safeStorage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createSafeStorageCredentialCipher } from '../safe-storage-credential-cipher';

function sealWith(tag: string): void {
  vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret');
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (text: string) =>
    Buffer.concat([Buffer.from(tag), Buffer.from(text)])
  );
}

describe('safeStorage credential cipher', () => {
  it('refuses to save a Linux credential under the fixed fallback key', async () => {
    sealWith('v10');
    await expect(createSafeStorageCredentialCipher('linux').seal('sk-fake')).rejects.toThrow(
      'The OS keyring is unavailable'
    );
  });

  it('saves a Linux credential the Secret Service sealed', async () => {
    sealWith('v11');
    const sealed = await createSafeStorageCredentialCipher('linux').seal('sk-fake');
    expect(Buffer.from(sealed, 'base64').toString()).toBe('v11sk-fake');
  });

  it('saves a macOS credential under its Keychain key', async () => {
    sealWith('v10');
    const sealed = await createSafeStorageCredentialCipher('darwin').seal('sk-fake');
    expect(Buffer.from(sealed, 'base64').toString()).toBe('v10sk-fake');
  });

  it('refuses to save while Linux has no recognised keyring', async () => {
    sealWith('v11');
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('basic_text');
    await expect(createSafeStorageCredentialCipher('linux').seal('sk-fake')).rejects.toThrow(
      'no OS credential encryption'
    );
  });
});
