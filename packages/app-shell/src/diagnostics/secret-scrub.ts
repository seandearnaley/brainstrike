/**
 * Value-shape secret scrub (design §5.2 review follow-up): a final regex
 * pass over the RENDERED debug-bundle text, independent of the key-name-based
 * `redactSensitiveLogValue` pass already applied to the data object. Catches
 * secrets that slip past key-name redaction because they live under an
 * innocuous key (e.g. a tool-result body, a free-text log message) — the
 * value's SHAPE, not its key, is what identifies it here.
 *
 * High-precision patterns only: each one is specific enough (fixed prefixes,
 * minimum lengths, structural anchors) that false positives on ordinary
 * prose, UUIDs, hashes, or short strings should be rare. This is a
 * belt-and-braces scan, not a general-purpose secret detector.
 */

export interface SecretScrubResult {
  readonly kinds: readonly string[];
  readonly redactedCount: number;
  readonly text: string;
}

interface ScrubPattern {
  readonly kind: string;
  readonly regex: RegExp;
}

// Order matters: more structurally specific patterns run first so a
// multi-line private key or a "Bearer <jwt>" header is redacted as ONE
// match under its more specific kind rather than being partially consumed
// by a later, more general pattern.
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
    // Replaces only the `scheme://user:pass@` prefix — host/port/db name
    // after the `@` is left intact (it's not the secret).
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g,
  },
];

/** Scans `text` for high-precision secret value shapes and replaces each
 * match with `[redacted-secret:<kind>]`. Pure, synchronous, no I/O. */
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
