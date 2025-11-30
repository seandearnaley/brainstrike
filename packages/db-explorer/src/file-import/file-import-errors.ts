import type { ImportProgress } from '@brainstrike/db';

export type FileImportErrorCode =
  | 'missing-dependency'
  | 'empty-selection'
  | 'invalid-selection'
  | 'file-unavailable'
  | 'unsupported-content'
  | 'no-valid-files'
  | 'unsupported-operation'
  | 'repository-error'
  | 'unknown';

type FileImportErrorOptions = {
  readonly cause?: unknown;
  readonly progress?: ImportProgress | null;
};

export class FileImportError extends Error {
  readonly code: FileImportErrorCode;

  readonly progress: ImportProgress | null;

  constructor(code: FileImportErrorCode, message: string, options: FileImportErrorOptions = {}) {
    const { cause, progress = null } = options;
    super(message, cause ? { cause } : undefined);
    this.name = 'FileImportError';
    this.code = code;
    this.progress = progress;
  }
}

export function isFileImportError(error: unknown): error is FileImportError {
  return error instanceof FileImportError;
}
