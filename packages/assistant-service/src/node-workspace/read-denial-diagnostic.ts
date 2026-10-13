import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { AccessError } from '@brainstrike/file-system';
import { isFileNotFoundError } from './file-not-found-error.js';

const MAX_READ_DENIAL_DIAGNOSTIC_LENGTH = 256;
const READ_DENIAL_TRUNCATION_MARKER = '…[truncated]';
const UNSAFE_LOG_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SAFE_FILESYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;
const SAFE_PATH_VALIDATION_CODE = /^[a-z][a-z0-9-]{0,31}$/u;

export interface ReadDenialErrorDiagnostic {
  readonly category: 'access' | 'filesystem' | 'path-validation';
  readonly code?: string;
  readonly message: string;
}

export function projectReadDenialError(error: unknown): ReadDenialErrorDiagnostic {
  if (!(error && typeof error === 'object')) {
    return { category: 'access', message: 'Workspace read access denied.' };
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly readDenialCategory?: unknown;
    readonly readDenialCode?: unknown;
  };
  if (
    candidate.readDenialCategory === 'path-validation' &&
    typeof candidate.readDenialCode === 'string' &&
    SAFE_PATH_VALIDATION_CODE.test(candidate.readDenialCode)
  ) {
    return {
      category: 'path-validation',
      code: candidate.readDenialCode,
      message: 'Workspace read path validation failed.',
    };
  }
  if (typeof candidate.code === 'string' && SAFE_FILESYSTEM_ERROR_CODE.test(candidate.code)) {
    return {
      category: 'filesystem',
      code: candidate.code,
      message: 'Workspace read filesystem operation failed.',
    };
  }
  return { category: 'access', message: 'Workspace read access denied.' };
}

export function projectReadDenialDiagnostic(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const fragments: string[] = [];
  let projectedLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error('Failed to project a workspace read diagnostic character');
    }
    const fragment = UNSAFE_LOG_CHARACTER.test(character)
      ? codePoint <= 0xff_ff
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : `\\u{${codePoint.toString(16)}}`
      : character;
    fragments.push(fragment);
    projectedLength += fragment.length;
    if (projectedLength <= MAX_READ_DENIAL_DIAGNOSTIC_LENGTH) {
      continue;
    }
    const prefixLimit = MAX_READ_DENIAL_DIAGNOSTIC_LENGTH - READ_DENIAL_TRUNCATION_MARKER.length;
    while (projectedLength > prefixLimit) {
      const removed = fragments.pop();
      if (removed === undefined) {
        throw new Error('Failed to bound a workspace read diagnostic');
      }
      projectedLength -= removed.length;
    }
    return `${fragments.join('')}${READ_DENIAL_TRUNCATION_MARKER}`;
  }
  return fragments.join('');
}

export function readDenialDiagnostic(error: unknown): ReadDenialErrorDiagnostic | undefined {
  if (error instanceof BoundaryFailureError && error.failure.kind === 'refusal') {
    return { category: 'access', code: error.code, message: error.message };
  }
  if (error instanceof AccessError && !isFileNotFoundError(error)) {
    return projectReadDenialError(error);
  }
  return undefined;
}
