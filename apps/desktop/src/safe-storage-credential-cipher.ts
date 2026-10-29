import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { app, safeStorage } from 'electron';

/**
 * Main's Electron safeStorage seals the profile's credential values through
 * Chromium's async encryptor. On macOS its Keychain key provider reads one
 * item, "<app name> Safe Storage", that the signed app creates and reads
 * without a prompt; Windows wraps the key with DPAPI. Both read values the
 * synchronous API sealed.
 *
 * Linux: `basic_text` (no recognised store) refuses. The async encryptor also
 * registers Chromium's fixed-key PosixKeyProvider as a fallback, so a Secret
 * Service that fails at runtime would seal with a key that protects nothing.
 * Chromium tags each ciphertext with its provider: on Linux `v10` is that fixed
 * key (the Secret Service seals `v11`, the portal `v12`), so a `v10` seal is
 * refused rather than saved. Electron offers no provider choice beyond this.
 */
const LINUX_FIXED_KEY_TAG = 'v10';

export function createSafeStorageCredentialCipher(
  platform: NodeJS.Platform = process.platform
): CredentialCipher {
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
      const sealed = await safeStorage.encryptStringAsync(plaintext);
      if (
        platform === 'linux' &&
        sealed.subarray(0, 3).toString('latin1') === LINUX_FIXED_KEY_TAG
      ) {
        throw new Error('The OS keyring is unavailable, so the credential was not saved.');
      }
      return sealed.toString('base64');
    },
  };
}
