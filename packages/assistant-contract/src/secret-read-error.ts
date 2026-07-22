export const SECRET_READ_ERROR_CODES = ['decrypt_failed', 'encryption_unavailable'] as const;

export type SecretReadErrorCode = (typeof SECRET_READ_ERROR_CODES)[number];

export function isSecretReadErrorCode(value: unknown): value is SecretReadErrorCode {
  return SECRET_READ_ERROR_CODES.some((code) => code === value);
}
