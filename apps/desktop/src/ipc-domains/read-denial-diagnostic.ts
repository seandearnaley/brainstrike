const MAX_READ_DENIAL_DIAGNOSTIC_LENGTH = 256;
const READ_DENIAL_TRUNCATION_MARKER = '…[truncated]';
const UNSAFE_LOG_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
