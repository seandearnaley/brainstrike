/**
 * Structural typing for the desktop `window.secrets` bridge (BST-1348).
 *
 * The SINGLE source of the bridge shape: the desktop preload implements it,
 * `apps/desktop/src/types/electron.d.ts` and the e2e globals declare it, and
 * settings-ui consumes the derived {@link SecretsCapability} view. The
 * required-method pin is consumed by the desktop preload-runtime contract test.
 *
 * IPC channels behind these methods NEVER throw domain errors across invoke —
 * Electron's `ipcRenderer.invoke` rejection path drops custom own-properties
 * (see ./secret-read-error.ts), so failures are serialized as data:
 * {@link SecretsWriteResult} and {@link SecretsCredentialReadResult}.
 */

import type { ProviderCredential } from './provider-credential.ts';
import type { ProviderKeySource } from './provider-key-source.ts';
import type { SupportedProvider } from './provider-metadata.ts';
import type { SecretReadErrorCode } from './secret-read-error.ts';

/** Result of `saveKey` / `saveCredential`: `true` or a typed structured failure. */
export type SecretsWriteResult =
  | true
  | { ok: false; error: 'encryption_unavailable' | 'malformed_credential' | 'unknown_error' };

/**
 * Result of `getCredential`: the credential (or `null` strictly for "not
 * set"), or a serialized `SecretReadError` as data.
 */
export type SecretsCredentialReadResult =
  | { ok: true; credential: ProviderCredential | null }
  | { ok: false; error: SecretReadErrorCode; provider: string };

export interface SecretsBridge {
  deleteKey: (provider: string) => Promise<boolean>;
  getCredential: (provider: string) => Promise<SecretsCredentialReadResult>;
  getKey: (provider: string) => Promise<string | null>;
  list: () => Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>;
  listStored: () => Promise<string[]>;
  saveCredential: (provider: string, credential: ProviderCredential) => Promise<SecretsWriteResult>;
  saveKey: (provider: string, value: string) => Promise<SecretsWriteResult>;
}

// Compile-time exact-set proof: `satisfies Record<keyof SecretsBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — the pin can never silently become a subset (or superset) of the
// interface.
const SECRETS_BRIDGE_REQUIRED_METHOD_SET = {
  deleteKey: true,
  getCredential: true,
  getKey: true,
  list: true,
  listStored: true,
  saveCredential: true,
  saveKey: true,
} as const satisfies Record<keyof SecretsBridge, true>;

/**
 * Every method name the preload's `window.secrets` surface must expose.
 * Exported so the desktop preload-runtime contract test can pin the
 * `exposeInMainWorld('secrets', …)` key set to this exact list.
 */
export const SECRETS_BRIDGE_REQUIRED_METHODS = Object.keys(
  SECRETS_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof SecretsBridge)[];

/**
 * Capability view consumed by settings-ui: the typed-credential methods may be
 * absent on an older desktop preload, so consumers capability-check them. The
 * shape still comes from {@link SecretsBridge} — never redeclared.
 */
export type SecretsCapability = Omit<SecretsBridge, 'getCredential' | 'saveCredential'> &
  Partial<Pick<SecretsBridge, 'getCredential' | 'saveCredential'>>;
