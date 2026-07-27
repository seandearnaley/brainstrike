import { describe, expect, it } from 'vitest';
import { formatTimestampedDownloadFilename } from '../download-filename';

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
