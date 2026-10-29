import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { app, safeStorage } from 'electron';

/**
 * Main's Electron safeStorage seals the profile's credential values through
 * Chromium's async encryptor. On macOS its Keychain key provider reads one
 * item, "<app name> Safe Storage", that the signed app creates and reads
 * without a prompt; Windows wraps the key with DPAPI. Both read values the
 * synchronous API sealed.
 *
 * Linux: the Secret Service provider seals when it answers, and `basic_text`
 * (no recognised store) refuses here. The async encryptor also registers
 * Chromium's fixed-key PosixKeyProvider as a fallback, so a Secret Service that
 * fails at runtime seals with a key that protects nothing, and Electron exposes
 * no way to tell which provider sealed. A later open reports
 * `shouldReEncrypt` once the Secret Service is back; nothing reseals yet.
 */
export function createSafeStorageCredentialCipher(): CredentialCipher {
  const available = async (): Promise<void> => {
    await app.whenReady();
    if (
      !(await safeStorage.isAsyncEncryptionAvailable()) ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      throw new Error('This system offers no OS credential encryption for saved credentials.');
    }
  };
  return {
    async open(sealed) {
      await available();
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
      return result;
    },
    async seal(plaintext) {
      await available();
      return (await safeStorage.encryptStringAsync(plaintext)).toString('base64');
    },
  };
}
