// This package's vitest environment is `node`, so the pure filename half and
// `downloadBlobFile`'s desktop-bridge route (which needs no DOM — a stubbed
// `globalThis.window` carries the bridge) are covered here. The web anchor
// route's DOM contract (anchor click, deferred vs immediate revoke) is
// covered in a DOM environment by
// packages/ui/src/__tests__/save-download.test.tsx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileExportsBridge, FileExportsSaveOutcome } from '../browser-download.js';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
  sanitizeFilenameSegment,
} from '../browser-download.js';

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

    expect(filename).not.toMatch(/[<>:"/\\|?*]/u);
    expect(filename.endsWith('.json')).toBe(true);
  });

  it('throws instead of emitting a nameless or extensionless file', () => {
    expect(() =>
      formatTimestampedDownloadFilename({ extension: 'json', generatedAt: AT, name: '::::' })
    ).toThrow(/name/iu);
    expect(() =>
      formatTimestampedDownloadFilename({ extension: '', generatedAt: AT, name: 'logs' })
    ).toThrow(/extension/iu);
  });

  it('rejects an invalid date rather than stamping "Invalid Date" into a filename', () => {
    expect(() =>
      formatTimestampedDownloadFilename({
        extension: 'json',
        generatedAt: new Date(Number.NaN),
        name: 'logs',
      })
    ).toThrow(/date/iu);
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

describe('downloadBlobFile (desktop bridge route)', () => {
  function stubWindowWithBridge(bridge: unknown): void {
    (globalThis as { window?: unknown }).window = { fileExports: bridge };
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.restoreAllMocks();
  });

  it('sends the blob bytes and filename over the bridge and resolves the written path', async () => {
    const saveToDownloads = vi
      .fn<FileExportsBridge['saveToDownloads']>()
      .mockResolvedValue({ ok: true, path: '/downloads/logs (1).json' });
    stubWindowWithBridge({ saveToDownloads });

    const saved = await downloadBlobFile({ blob: new Blob(['{"a":1}']), filename: 'logs.json' });

    expect(saveToDownloads).toHaveBeenCalledTimes(1);
    const payload = saveToDownloads.mock.calls[0]?.[0];
    expect(payload?.filename).toBe('logs.json');
    expect(new TextDecoder().decode(payload?.bytes)).toBe('{"a":1}');
    // Main may have countered the name (never overwrites) — the resolved path
    // is the file actually written, for callers that name it to the user.
    expect(saved).toEqual({ path: '/downloads/logs (1).json' });
  });

  it('throws the bridge error when the save fails (never falls back to the anchor route)', async () => {
    stubWindowWithBridge({
      saveToDownloads: vi
        .fn<FileExportsBridge['saveToDownloads']>()
        .mockResolvedValue({ error: 'disk full', ok: false }),
    });

    await expect(downloadBlobFile({ blob: new Blob(['x']), filename: 'x.md' })).rejects.toThrow(
      'disk full'
    );
  });

  it('throws a stable message when the save fails without an error string', async () => {
    stubWindowWithBridge({
      saveToDownloads: vi
        .fn<() => Promise<FileExportsSaveOutcome>>()
        .mockResolvedValue({ ok: false }),
    });

    await expect(downloadBlobFile({ blob: new Blob(['x']), filename: 'x.md' })).rejects.toThrow(
      'Desktop save failed without an error message.'
    );
  });

  it.each([
    ['an empty object', {}],
    ['null (present-but-broken, not absent)', null],
  ])(
    'throws on a present-but-malformed bridge (%s) instead of degrading to the anchor route',
    async (_label, bridge) => {
      stubWindowWithBridge(bridge);

      await expect(downloadBlobFile({ blob: new Blob(['x']), filename: 'x.md' })).rejects.toThrow(
        'window.fileExports bridge is malformed'
      );
    }
  );

  it('still refuses to run without a document when neither bridge nor DOM exists', async () => {
    await expect(downloadBlobFile({ blob: new Blob(['x']), filename: 'x.md' })).rejects.toThrow(
      'Downloads are unavailable outside a browser document.'
    );
  });
});
