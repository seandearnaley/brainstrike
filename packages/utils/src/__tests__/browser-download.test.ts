// This package's vitest environment is `node`, so only the pure half of
// `browser-download.ts` is covered here. `downloadBlobFile`'s DOM contract
// (anchor click, deferred vs immediate revoke) is covered in a DOM
// environment by packages/ui/src/__tests__/debug-bundle-download.test.ts.
import { describe, expect, it } from 'vitest';
import { formatTimestampedDownloadFilename, sanitizeFilenameSegment } from '../browser-download.js';

const AT = new Date('2026-07-27T14:32:05.123Z');

describe('formatTimestampedDownloadFilename', () => {
  it('stamps a filesystem-safe UTC timestamp (no colons, no millis)', () => {
    expect(
      formatTimestampedDownloadFilename({
        extension: 'json',
        generatedAt: AT,
        name: 'brainstrike-logs',
      })
    ).toBe('brainstrike-logs-2026-07-27T14-32-05Z.json');
  });

  it('appends a caller-supplied suffix after the timestamp', () => {
    expect(
      formatTimestampedDownloadFilename({
        extension: 'ndjson',
        generatedAt: AT,
        name: 'brainstrike-errors',
        suffix: 'recent2000',
      })
    ).toBe('brainstrike-errors-2026-07-27T14-32-05Z-recent2000.ndjson');
  });

  it('omits the suffix segment entirely when it is absent or sanitizes to nothing', () => {
    const expected = 'brainstrike-errors-2026-07-27T14-32-05Z.ndjson';
    for (const suffix of [undefined, null, '', '::::']) {
      expect(
        formatTimestampedDownloadFilename({
          extension: 'ndjson',
          generatedAt: AT,
          name: 'brainstrike-errors',
          suffix,
        })
      ).toBe(expected);
    }
  });

  it('tolerates a dotted extension without doubling the separator', () => {
    expect(
      formatTimestampedDownloadFilename({ extension: '.md', generatedAt: AT, name: 'bundle' })
    ).toBe('bundle-2026-07-27T14-32-05Z.md');
  });

  it('never emits path separators or characters Windows rejects', () => {
    const filename = formatTimestampedDownloadFilename({
      extension: 'json',
      generatedAt: AT,
      name: 'weird/name',
      suffix: 'run:id\\with*chars',
    });

    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(filename.endsWith('.json')).toBe(true);
  });

  it('throws instead of emitting a nameless or extensionless file', () => {
    expect(() =>
      formatTimestampedDownloadFilename({ extension: 'json', generatedAt: AT, name: '::::' })
    ).toThrow(/name/i);
    expect(() =>
      formatTimestampedDownloadFilename({ extension: '', generatedAt: AT, name: 'logs' })
    ).toThrow(/extension/i);
  });

  it('rejects an invalid date rather than stamping "Invalid Date" into a filename', () => {
    expect(() =>
      formatTimestampedDownloadFilename({
        extension: 'json',
        generatedAt: new Date(Number.NaN),
        name: 'logs',
      })
    ).toThrow(/date/i);
  });
});

describe('sanitizeFilenameSegment', () => {
  // Pins the charset callers measure against: `formatDebugBundleFilename`
  // sanitizes a run id BEFORE truncating it to 8 characters, so both must
  // strip exactly the same set or the truncation yields fewer usable ones.
  it('strips everything the filename builder would strip, and nothing else', () => {
    expect(sanitizeFilenameSegment('1a2b3c4d-5e6f/78:90*ab')).toBe('1a2b3c4d-5e6f7890ab');
    expect(sanitizeFilenameSegment('keeps.dots_and-dashes')).toBe('keeps.dots_and-dashes');
    expect(sanitizeFilenameSegment('::::')).toBe('');
  });

  it('agrees with the filename builder on what survives', () => {
    const raw = 'a b<c>d:e"f/g\\h|i?j*k';
    const filename = formatTimestampedDownloadFilename({
      extension: 'json',
      generatedAt: AT,
      name: 'logs',
      suffix: raw,
    });

    expect(filename).toContain(`-${sanitizeFilenameSegment(raw)}.json`);
  });
});
