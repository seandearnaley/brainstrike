const MAX_DIAGNOSTIC_CHUNK_TYPE_LENGTH = 128;

export function formatDiagnosticChunkType(value: unknown): string {
  if (typeof value !== 'string') {
    return '<non-string>';
  }
  if (value.length <= MAX_DIAGNOSTIC_CHUNK_TYPE_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DIAGNOSTIC_CHUNK_TYPE_LENGTH - 3)}...`;
}
