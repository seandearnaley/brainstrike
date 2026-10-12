export function isFileNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const codeCandidate = (error as { code?: unknown }).code;
  if (codeCandidate === 'ENOENT') {
    return true;
  }
  const messageCandidate = (error as { message?: unknown }).message;
  return typeof messageCandidate === 'string' && messageCandidate.includes('ENOENT');
}
