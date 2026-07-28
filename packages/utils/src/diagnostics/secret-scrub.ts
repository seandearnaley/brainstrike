export interface SecretScrubResult {
  readonly kinds: readonly string[];
  readonly redactedCount: number;
  readonly text: string;
}

interface ScrubPattern {
  readonly kind: string;
  readonly regex: RegExp;
}

const PATTERNS: readonly ScrubPattern[] = [
  {
    kind: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'github-token',
    regex: /(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  {
    kind: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    kind: 'slack-token',
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    kind: 'api-key',
    regex: /sk-[A-Za-z0-9_-]{16,}/g,
  },
  {
    kind: 'bearer-token',
    regex: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    kind: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  },
  {
    kind: 'db-credentials',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g,
  },
];

/**
 * Scans rendered text for high-precision secret value shapes and replaces
 * each match with an explicit marker. This complements key-name redaction
 * when secrets occur in free text or under innocuous keys.
 */
export function scrubLikelySecretValues(text: string): SecretScrubResult {
  let result = text;
  let redactedCount = 0;
  const kinds = new Set<string>();

  for (const pattern of PATTERNS) {
    result = result.replace(pattern.regex, () => {
      redactedCount += 1;
      kinds.add(pattern.kind);
      return `[redacted-secret:${pattern.kind}]`;
    });
  }

  return {
    kinds: Array.from(kinds).sort(),
    redactedCount,
    text: result,
  };
}
