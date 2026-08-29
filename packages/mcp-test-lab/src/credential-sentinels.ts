export function isSafeAuthorizationSchemeMatch(kind: string, match: string): boolean {
  return (
    (kind === 'basic-credential' || kind === 'bearer-token') &&
    /\b(?:disabled|none|redacted)$/iu.test(match)
  );
}

export function isSafeDiagnosticAssignment(label: string, value: string, prefix: string): boolean {
  if (/^(?:disabled|none|redacted)$/iu.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^not[-_ ]required(?:[-_ ].*)?$/iu.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^(?:basic|bearer)$/iu.test(value)) {
    return true;
  }
  return (
    label === 'code' && /(?:error|exit)[ \t]+$/iu.test(prefix) && /^[A-Z][A-Z0-9_]*$/u.test(value)
  );
}
