import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { app, safeStorage } from 'electron';

/**
 * Main's Electron safeStorage seals the profile's credential values. On macOS
 * its key is one keychain item, "<app name> Safe Storage", that the signed app
 * creates and reads without a prompt; Windows wraps it with DPAPI and Linux
 * with the Secret Service. Linux's `basic_text` store protects nothing, so it
 * refuses. Chromium's async encryptor has no macOS key provider by default and
 * a fixed Linux fallback key, so this uses the synchronous calls.
 */
export function createSafeStorageCredentialCipher(): CredentialCipher {
  const available = async (): Promise<void> => {
    await app.whenReady();
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      throw new Error('This system offers no OS credential encryption for saved credentials.');
    }
  };
  return {
    async open(sealed) {
      await available();
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    },
    async seal(plaintext) {
      await available();
      return safeStorage.encryptString(plaintext).toString('base64');
    },
  };
}
