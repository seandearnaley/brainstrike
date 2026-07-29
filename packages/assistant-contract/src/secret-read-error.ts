export const SECRET_READ_ERROR_CODES = ['decrypt_failed', 'encryption_unavailable'] as const;

export type SecretReadErrorCode = (typeof SECRET_READ_ERROR_CODES)[number];

export function isSecretReadErrorCode(value: unknown): value is SecretReadErrorCode {
  return SECRET_READ_ERROR_CODES.some((code) => code === value);
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
 * code + provider) rather than by `instanceof`, so server modules can react to
 * these failures without importing the electron-coupled module that declares
 * the class (BST-972 A3). The conformance money test — the real class through
 * this matcher — lives beside the class in apps/desktop's secrets.test.ts,
 * where both sides are importable.
 */
export function matchSecretReadError(error: unknown): SecretReadErrorShape | undefined {
  if (!(error instanceof Error) || error.name !== 'SecretReadError') {
    return;
  }
  const candidate = error as Error & { code?: unknown; provider?: unknown };
  if (!isSecretReadErrorCode(candidate.code) || typeof candidate.provider !== 'string') {
    return;
  }
  return { code: candidate.code, message: error.message, provider: candidate.provider };
}
