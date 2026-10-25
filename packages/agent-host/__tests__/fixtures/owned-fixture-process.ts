import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function redact(value: string): string {
  return value
    .replace(/("(?:token|password|apiKey|authorization)"\s*:\s*")[^"]*/gi, '$1[REDACTED]')
    .replace(/((?:token|password|api[_-]?key|authorization)=)[^\s]+/gi, '$1[REDACTED]');
}

function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactEvidence);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:token|password|api[_-]?key|authorization|secret)$/i.test(key)
          ? '[REDACTED]'
          : redactEvidence(item),
      ])
    );
  }
  return value;
}

/** One append-only ledger; never persist the inherited environment or host token. */
export function recordFixtureEvent(event: string, detail: unknown): void {
  const directory = process.env['M3_WINDOWS_EVIDENCE_DIR'];
  if (!directory) {
    return;
  }
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    join(directory, 'fixture-ledger.jsonl'),
    `${JSON.stringify({ detail: redactEvidence(detail), event, utc: new Date().toISOString() })}\n`
  );
}
