export const FILE_READ_ERROR_CODE_TOO_LARGE = 'TOO_LARGE' as const;
/**
 * The target path does not exist on disk. Distinct from TOO_LARGE because
 * callers may want to treat "missing" as "remove from view" rather than as
 * an alert-worthy IO failure. Returning this as a payload (instead of
 * throwing) keeps ipcMain from auto-logging the failure at error level —
 * which would create noise during normal file-tree refresh after deletes.
 */
export const FILE_READ_ERROR_CODE_NOT_FOUND = 'NOT_FOUND' as const;

export type FileReadErrorCode =
  | typeof FILE_READ_ERROR_CODE_TOO_LARGE
  | typeof FILE_READ_ERROR_CODE_NOT_FOUND;

export interface FileReadErrorPayload {
  code: FileReadErrorCode;
  message: string;
}

export function createFileReadErrorPayload(
  message: string,
  code: FileReadErrorCode = FILE_READ_ERROR_CODE_TOO_LARGE
): FileReadErrorPayload {
  return { code, message };
}

export function isFileReadErrorPayload(value: unknown): value is FileReadErrorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    (candidate.code === FILE_READ_ERROR_CODE_TOO_LARGE ||
      candidate.code === FILE_READ_ERROR_CODE_NOT_FOUND) &&
    typeof candidate.message === 'string'
  );
}
