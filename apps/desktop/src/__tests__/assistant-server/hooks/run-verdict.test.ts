/**
 * Strict parsing of hook-reported run-verdict lines (Task Ledger source 'hook').
 *
 * A Stop hook's stdout may include a single JSON line of the form
 * `{"brainstrikeRunVerdict":{"verdict":"failed","detail":"3 tests failing"}}`.
 * The scanner is STRICT: unknown verdict values, oversized detail, extra keys,
 * or malformed JSON on a candidate line produce a visible warning and the line
 * is ignored — never coerced, and a bad line never fails the hook flow. Only
 * the trailing RUN_VERDICT_STDOUT_SCAN_CHARS of stdout are scanned (documented
 * bound); a candidate line is any line containing the marker key.
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_VERDICT_DETAIL_MAX_CHARS,
  RUN_VERDICT_KEY,
  RUN_VERDICT_STDOUT_SCAN_CHARS,
  scanStdoutForRunVerdict,
} from '../../../assistant-server/hooks/run-verdict';

function verdictLine(verdict: string, detail?: string): string {
  return JSON.stringify({
    [RUN_VERDICT_KEY]: { verdict, ...(detail === undefined ? {} : { detail }) },
  });
}

describe('scanStdoutForRunVerdict', () => {
  it('returns no verdict and no warnings for empty stdout', () => {
    expect(scanStdoutForRunVerdict('')).toEqual({ warnings: [] });
  });

  it('ignores ordinary output lines without the marker key', () => {
    const result = scanStdoutForRunVerdict('running tests...\nall 12 passed\n');
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('extracts a valid verdict line embedded in ordinary output', () => {
    const stdout = `running tests...\n${verdictLine('failed', '3 tests failing')}\ndone\n`;
    const result = scanStdoutForRunVerdict(stdout);
    expect(result.verdict).toEqual({ detail: '3 tests failing', verdict: 'failed' });
    expect(result.warnings).toEqual([]);
  });

  it('accepts a verdict without detail', () => {
    const result = scanStdoutForRunVerdict(verdictLine('succeeded'));
    expect(result.verdict).toEqual({ verdict: 'succeeded' });
  });

  it('accepts all three verdict values', () => {
    for (const verdict of ['succeeded', 'failed', 'mixed'] as const) {
      expect(scanStdoutForRunVerdict(verdictLine(verdict)).verdict).toEqual({ verdict });
    }
  });

  it('lets the LAST valid verdict line win when several are present', () => {
    const stdout = `${verdictLine('succeeded')}\nmore output\n${verdictLine('mixed', 'flaky suite')}\n`;
    expect(scanStdoutForRunVerdict(stdout).verdict).toEqual({
      detail: 'flaky suite',
      verdict: 'mixed',
    });
  });

  it('warns and ignores a candidate line with malformed JSON', () => {
    const result = scanStdoutForRunVerdict(`{"${RUN_VERDICT_KEY}": {"verdict": "failed"`);
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('invalid JSON');
  });

  it('warns and ignores an unknown verdict value (never coerces)', () => {
    const result = scanStdoutForRunVerdict(verdictLine('passed'));
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('verdict');
  });

  it('warns and ignores an oversized detail (never truncates)', () => {
    const result = scanStdoutForRunVerdict(
      verdictLine('failed', 'x'.repeat(RUN_VERDICT_DETAIL_MAX_CHARS + 1))
    );
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(String(RUN_VERDICT_DETAIL_MAX_CHARS));
  });

  it('accepts a detail exactly at the bound', () => {
    const detail = 'x'.repeat(RUN_VERDICT_DETAIL_MAX_CHARS);
    expect(scanStdoutForRunVerdict(verdictLine('failed', detail)).verdict).toEqual({
      detail,
      verdict: 'failed',
    });
  });

  it('warns and ignores a non-string detail', () => {
    const line = JSON.stringify({ [RUN_VERDICT_KEY]: { detail: 42, verdict: 'failed' } });
    const result = scanStdoutForRunVerdict(line);
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and ignores unknown keys inside the verdict object', () => {
    const line = JSON.stringify({
      [RUN_VERDICT_KEY]: { extra: true, verdict: 'failed' },
    });
    const result = scanStdoutForRunVerdict(line);
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and ignores extra top-level keys next to the marker', () => {
    const line = JSON.stringify({
      [RUN_VERDICT_KEY]: { verdict: 'failed' },
      other: 1,
    });
    const result = scanStdoutForRunVerdict(line);
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it('warns and ignores a candidate line whose JSON is not an object', () => {
    const result = scanStdoutForRunVerdict(`"${RUN_VERDICT_KEY}"`);
    expect(result.verdict).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it('never includes hook stdout content in warnings (bounded, content-free)', () => {
    const secret = 'super-secret-value-abc123';
    const result = scanStdoutForRunVerdict(`{"${RUN_VERDICT_KEY}": "${secret}"}`);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain(secret);
  });

  it('a later valid line overrides an earlier invalid one (warning still surfaced)', () => {
    const stdout = `${verdictLine('bogus')}\n${verdictLine('succeeded')}\n`;
    const result = scanStdoutForRunVerdict(stdout);
    expect(result.verdict).toEqual({ verdict: 'succeeded' });
    expect(result.warnings).toHaveLength(1);
  });

  describe('bounded scan window', () => {
    it('finds a verdict line within the trailing window of a huge stdout', () => {
      const stdout = `${'noise\n'.repeat(50_000)}${verdictLine('failed', 'late line')}\n`;
      expect(scanStdoutForRunVerdict(stdout).verdict).toEqual({
        detail: 'late line',
        verdict: 'failed',
      });
    });

    it('ignores a verdict line that falls outside the trailing window', () => {
      const trailing = 'z'.repeat(RUN_VERDICT_STDOUT_SCAN_CHARS);
      const stdout = `${verdictLine('failed')}\n${trailing}\n`;
      const result = scanStdoutForRunVerdict(stdout);
      expect(result.verdict).toBeUndefined();
      expect(result.warnings).toEqual([]);
    });

    it('drops the partial first line of the window instead of parsing corrupted JSON', () => {
      // The verdict line STARTS before the window boundary: the slice lands
      // mid-line, so the partial fragment must be discarded, not parsed (a
      // corrupted candidate would otherwise surface a misleading warning).
      const line = verdictLine('failed', 'y'.repeat(200));
      const padding = 'z'.repeat(RUN_VERDICT_STDOUT_SCAN_CHARS - 100);
      const result = scanStdoutForRunVerdict(`${line}\n${padding}`);
      expect(result.verdict).toBeUndefined();
      expect(result.warnings).toEqual([]);
    });
  });
});
