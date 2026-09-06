export type EvidenceSecretKind =
  | 'authorization-code'
  | 'aws-access-key-id'
  | 'basic-credential'
  | 'bearer-token'
  | 'credential-assignment'
  | 'credential-bearing-url'
  | 'github-token'
  | 'jwt'
  | 'npm-token'
  | 'pkce-verifier'
  | 'private-key';

export interface EvidenceSecretFinding {
  readonly index: number;
  readonly kind: EvidenceSecretKind;
}

interface SecretPattern {
  readonly kind: EvidenceSecretKind;
  readonly pattern: RegExp;
}

const SAFE_SENTINEL_PATTERN = /^(?:disabled|none|redacted)$/iu;
// This evidence policy is intentionally narrower than scripts/secret-scan.mjs:
// it implements the credential families named by the evidence contract plus
// representation-level credential syntax. The commit scanner has a different
// repository-ingress policy and must not become a runtime dependency here.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/giu,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/giu,
  },
  {
    kind: 'github-token',
    pattern: /\b(?:github_pat_[a-z0-9_]{82,}|(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9_]{36,})\b/giu,
  },
  {
    kind: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  },
  {
    kind: 'npm-token',
    pattern: /\bnpm_[a-z0-9]{36}\b/giu,
  },
];

const AUTHORIZATION_SCHEME_PATTERN =
  /\bauthorization(["']?)[ \t]*[:=][ \t]*(["']?)(basic|bearer)[ \t]+([^\s"']+)/giu;
const AUTHENTICATION_PROSE_NOUNS = new Set([
  'authentication',
  'credential',
  'credentials',
  'token',
]);
const NPMRC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?<![a-z0-9_.-])((?:\/\/[^\s=]+\/:)?_(?:authToken|password|auth))[ \t]*=[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s]+))/giu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const CREDENTIAL_KEYS = [
  'access_token',
  'api_key',
  'auth_code',
  'authorization',
  'authorization_code',
  'client_secret',
  'code',
  'code_verifier',
  'password',
  'pkce_verifier',
  'refresh_token',
  'token',
] as const;
const AMBIGUOUS_CREDENTIAL_KEYS = ['authorization', 'code', 'token'] as const;
const NAMESPACED_CREDENTIAL_KEY_SUFFIXES = [...CREDENTIAL_KEYS, 'secret_access_key'].filter(
  (key) => !(AMBIGUOUS_CREDENTIAL_KEYS as readonly string[]).includes(key)
);
const TRUSTED_NAMESPACED_CREDENTIAL_LABELS = new Map<string, string>([
  ['aws_access_key_id', 'api_key'],
  ['aws_bearer_token_bedrock', 'token'],
  ['aws_secret_access_key', 'secret_access_key'],
  ['aws_session_token', 'token'],
  ['gh_enterprise_token', 'token'],
  ['gh_token', 'token'],
  ['github_enterprise_token', 'token'],
  ['github_token', 'token'],
  ['node_auth_token', 'token'],
  ['npm_token', 'token'],
]);
const AMBIGUOUS_ASSIGNMENT_KEYS = AMBIGUOUS_CREDENTIAL_KEYS.map((key) =>
  key.replaceAll('_', '[_ .-]')
);
const TRUSTED_NAMESPACED_ASSIGNMENT_KEYS = [...TRUSTED_NAMESPACED_CREDENTIAL_LABELS.keys()].map(
  (key) => key.replaceAll('_', '[_ .-]')
);
const NAMESPACED_ASSIGNMENT_KEYS = NAMESPACED_CREDENTIAL_KEY_SUFFIXES.map((key) =>
  key.replaceAll('_', '[_ .-]')
);
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `(?<![a-z0-9_.-])((?:${AMBIGUOUS_ASSIGNMENT_KEYS.join('|')})|(?:${TRUSTED_NAMESPACED_ASSIGNMENT_KEYS.join('|')})|(?:[a-z0-9]+[_.-])*(?:${NAMESPACED_ASSIGNMENT_KEYS.join('|')}))["']?[ \\t]*[:=][ \\t]*(?:"([^"]+)"|'([^']+)'|([^\\s]+))`,
  'giu'
);

export function scanEvidenceTextForSecrets(text: string): readonly EvidenceSecretFinding[] {
  const findings: EvidenceSecretFinding[] = [];
  const urlRanges = scanCredentialUrls(text, findings);
  scanAuthorizationHeaders(text, findings);
  scanKnownSecretFormats(text, findings);
  scanNpmrcAssignments(text, findings);
  scanCredentialAssignments(text, urlRanges, findings);
  findings.sort(
    (left, right) =>
      left.index - right.index || (left.kind < right.kind ? -1 : Number(left.kind > right.kind))
  );
  return findings;
}

function scanCredentialUrls(
  text: string,
  findings: EvidenceSecretFinding[]
): readonly { readonly end: number; readonly start: number }[] {
  const urlRanges: { readonly end: number; readonly start: number }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0];
    const url = parseCredentialUrl(candidate);
    if (url === undefined) {
      continue;
    }
    urlRanges.push({ end: match.index + candidate.length, start: match.index });
    if (hasEmbeddedUrlCredential(url)) {
      findings.push({ index: match.index, kind: 'credential-bearing-url' });
    }
  }
  return urlRanges;
}

function scanAuthorizationHeaders(text: string, findings: EvidenceSecretFinding[]): void {
  for (const match of text.matchAll(AUTHORIZATION_SCHEME_PATTERN)) {
    const valueQuote = match[2] ?? '';
    const scheme = match[3]?.toLowerCase();
    const credential = match[4] ?? '';
    const diagnosticCredential = credential.replace(/[),.;\]}]+$/u, '');
    const lineRemainder = authorizationLineRemainder(text, match.index + match[0].length);
    if (isSafeAuthorizationCredential(diagnosticCredential, lineRemainder, valueQuote)) {
      continue;
    }
    findings.push({
      index: match.index,
      kind: scheme === 'basic' ? 'basic-credential' : 'bearer-token',
    });
  }
}

function scanKnownSecretFormats(text: string, findings: EvidenceSecretFinding[]): void {
  for (const { kind, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ index: match.index, kind });
    }
  }
}

function scanNpmrcAssignments(text: string, findings: EvidenceSecretFinding[]): void {
  for (const match of text.matchAll(NPMRC_CREDENTIAL_ASSIGNMENT_PATTERN)) {
    const assignedValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (!isSafeEvidenceCredentialValue('token', assignedValue)) {
      findings.push({ index: match.index, kind: 'credential-assignment' });
    }
  }
}

function scanCredentialAssignments(
  text: string,
  urlRanges: readonly { readonly end: number; readonly start: number }[],
  findings: EvidenceSecretFinding[]
): void {
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT_PATTERN)) {
    if (urlRanges.some((range) => match.index >= range.start && match.index < range.end)) {
      continue;
    }
    const label = classifyEvidenceCredentialKey(match[1] ?? '');
    if (label === undefined) {
      continue;
    }
    const assignedValue = match[2] ?? match[3] ?? match[4] ?? '';
    const diagnosticValue =
      match[4] === undefined ? assignedValue : assignedValue.replace(/[),.;\]}]+$/u, '');
    const prefix = text.slice(Math.max(0, match.index - 16), match.index);
    if (!isSafeEvidenceCredentialValue(label, diagnosticValue, prefix)) {
      findings.push({ index: match.index, kind: secretKindForCredentialLabel(label) });
    }
  }
}

function parseCredentialUrl(candidate: string): URL | undefined {
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}

function hasEmbeddedUrlCredential(url: URL): boolean {
  return (
    url.username.length > 0 ||
    url.password.length > 0 ||
    hasCredentialParameter(url.searchParams) ||
    hasCredentialParameter(fragmentParameters(url.hash))
  );
}

function fragmentParameters(hash: string): URLSearchParams {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = fragment.indexOf('?');
  return new URLSearchParams(queryIndex === -1 ? fragment : fragment.slice(queryIndex + 1));
}

function hasCredentialParameter(parameters: URLSearchParams): boolean {
  for (const [key, value] of parameters) {
    const label = classifyEvidenceCredentialKey(key);
    if (value.length > 0 && label !== undefined && !isSafeEvidenceCredentialValue(label, value)) {
      return true;
    }
  }
  return false;
}

export function classifyEvidenceCredentialKey(key: string): string | undefined {
  const normalizedKey = key.toLowerCase().replaceAll(/[ .-]/gu, '_');
  const exact = CREDENTIAL_KEYS.find((candidate) => normalizedKey === candidate);
  if (exact !== undefined) {
    return exact;
  }
  const trusted = TRUSTED_NAMESPACED_CREDENTIAL_LABELS.get(normalizedKey);
  if (trusted !== undefined) {
    return trusted;
  }
  return NAMESPACED_CREDENTIAL_KEY_SUFFIXES.find((suffix) => normalizedKey.endsWith(`_${suffix}`));
}

function authorizationLineRemainder(text: string, offset: number): string {
  const remainder = text.slice(offset);
  const lineBreak = remainder.search(/[\r\n]/u);
  return lineBreak === -1 ? remainder : remainder.slice(0, lineBreak);
}

function isSafeAuthorizationCredential(
  credential: string,
  lineRemainder: string,
  valueQuote: string
): boolean {
  const valueRemainder = authorizationValueRemainder(lineRemainder, valueQuote);
  if (valueRemainder === undefined) {
    return false;
  }
  if (SAFE_SENTINEL_PATTERN.test(credential) && /^[ \t]*[),.;\]}]*[ \t]*$/u.test(valueRemainder)) {
    return true;
  }
  if (
    AUTHENTICATION_PROSE_NOUNS.has(credential.toLowerCase()) &&
    /^[ \t]+(?:is|are)[ \t]+(?:not[ \t]+)?(?:available|disabled|required|supported)(?:[.!]?[ \t]*)$/iu.test(
      valueRemainder
    )
  ) {
    return true;
  }
  return false;
}

function authorizationValueRemainder(
  lineRemainder: string,
  valueQuote: string
): string | undefined {
  if (valueQuote.length === 0) {
    return lineRemainder;
  }
  const closingQuote = lineRemainder.indexOf(valueQuote);
  return closingQuote === -1 ? undefined : lineRemainder.slice(0, closingQuote);
}

export function isSafeEvidenceCredentialValue(label: string, value: string, prefix = ''): boolean {
  if (SAFE_SENTINEL_PATTERN.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^not[-_ ]required(?:[-_ ].*)?$/iu.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^(?:basic|bearer)$/iu.test(value)) {
    return true;
  }
  if (
    label === 'authorization' &&
    /^(?:basic|bearer)[ \t]+(?:disabled|none|redacted)$/iu.test(value)
  ) {
    return true;
  }
  return (
    label === 'code' && /(?:error|exit)[ \t]+$/iu.test(prefix) && /^[A-Z][A-Z0-9_]*$/u.test(value)
  );
}

export function secretKindForCredentialLabel(label: string): EvidenceSecretKind {
  if (label.includes('verifier')) {
    return 'pkce-verifier';
  }
  if (label === 'code' || label.endsWith('_code')) {
    return 'authorization-code';
  }
  return 'credential-assignment';
}
