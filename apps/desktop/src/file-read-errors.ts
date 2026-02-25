export const FILE_READ_ERROR_CODE_TOO_LARGE = 'TOO_LARGE' as const;

export interface FileReadErrorPayload {
  code: typeof FILE_READ_ERROR_CODE_TOO_LARGE;
  message: string;
}

export function createFileReadErrorPayload(message: string): FileReadErrorPayload {
  return {
    code: FILE_READ_ERROR_CODE_TOO_LARGE,
    message,
  };
}

export function isFileReadErrorPayload(value: unknown): value is FileReadErrorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return candidate.code === FILE_READ_ERROR_CODE_TOO_LARGE && typeof candidate.message === 'string';
}
