export const SECRET_READ_ERROR_CODES = [
  'credential_type_unsupported',
  'decrypt_failed',
  'encryption_unavailable',
  'malformed_credential',
] as const;

export type SecretReadErrorCode = (typeof SECRET_READ_ERROR_CODES)[number];

export function isSecretReadErrorCode(value: unknown): value is SecretReadErrorCode {
  return SECRET_READ_ERROR_CODES.some((code) => code === value);
}

/**
 * Canonical per-code detail text (BST-1352 review): ONE declaration, consumed
 * by the desktop `SecretReadError` and the assistant-service
 * `UnsupportedCredentialTypeError` so the two producers can never drift on
 * wire-visible message text. Static by contract — never interpolate stored
 * values.
 */
export const SECRET_READ_ERROR_DETAILS: Record<SecretReadErrorCode, string> = {
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  credential_type_unsupported:
    'stored credential uses a newer auth flow; re-enter an API key or reconnect the provider',
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  decrypt_failed: 'stored secret could not be decrypted (the OS keychain entry may have changed)',
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  encryption_unavailable: 'safeStorage encryption is unavailable or insecure on this system',
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  malformed_credential:
    'stored credential payload is tagged but unrecognized or invalid (never coerced to an API key)',
};

/**
 * The canonical secret-read failure message every SecretReadError-shaped
 * producer uses. The exact composition is wire-visible (it reaches the
 * `api_key_unreadable` payload and Settings repair guidance) — change it only
 * with the paired tests.
 */
export function describeSecretReadError(code: SecretReadErrorCode, provider: string): string {
  return `Secret for "${provider}" is unreadable: ${SECRET_READ_ERROR_DETAILS[code]}. Re-enter the key to repair it.`;
}

/**
 * Structural view of the desktop `SecretReadError` (declared in
 * apps/desktop/src/secrets.ts, which imports electron at module scope).
 */
export interface SecretReadErrorShape {
  readonly code: SecretReadErrorCode;
  readonly message: string;
  readonly provider: string;
}

/**
 * Classify a thrown value as a secret-read failure STRUCTURALLY (name + valid
 * code + provider + message) rather than by `instanceof`, so server modules
 * can react to these failures without importing the electron-coupled module
 * that declares the class (BST-972 A3). Deliberately shape-only in EVERY
 * dimension — no `instanceof Error` — so a value revived across a
 * structured-clone/JSON boundary still matches (the transport-independent run
 * service is exactly where these errors will arrive revived). Caveat recorded
 * for that future hop: Electron's `ipcRenderer.invoke` rejection path drops
 * custom own-properties entirely, so an IPC crossing needs an explicit
 * serialize/revive step for this error family regardless. The conformance
 * money test — the real class through this matcher — lives beside the class in
 * apps/desktop's secrets.test.ts, where both sides are importable.
 */
export function matchSecretReadError(error: unknown): SecretReadErrorShape | undefined {
  if (typeof error !== 'object' || error === null) {
    return;
  }
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    provider?: unknown;
  };
  if (candidate.name !== 'SecretReadError' || typeof candidate.message !== 'string') {
    return;
  }
  if (!isSecretReadErrorCode(candidate.code) || typeof candidate.provider !== 'string') {
    return;
  }
  return { code: candidate.code, message: candidate.message, provider: candidate.provider };
}
