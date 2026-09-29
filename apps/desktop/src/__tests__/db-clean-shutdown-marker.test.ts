import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanShutdownMarkerNamesPid,
  hasCleanShutdownMarker,
  removeCleanShutdownMarker,
  writeCleanShutdownMarker,
} from '../db-clean-shutdown-marker';

describe('clean-shutdown marker', () => {
  let appDataDir: string;
  const markerPath = (): string => path.join(appDataDir, '.db-clean-shutdown');

  beforeEach(() => {
    appDataDir = mkdtempSync(path.join(tmpdir(), 'brainstrike-marker-'));
  });

  afterEach(() => {
    rmSync(appDataDir, { force: true, recursive: true });
  });

  it('is absent until written, present after, and absent again once removed', () => {
    expect(hasCleanShutdownMarker(appDataDir)).toBe(false);

    writeCleanShutdownMarker(appDataDir, { closedAt: '2026-09-29T00:00:00.000Z', pid: 4242 });
    expect(hasCleanShutdownMarker(appDataDir)).toBe(true);

    removeCleanShutdownMarker(appDataDir);
    expect(hasCleanShutdownMarker(appDataDir)).toBe(false);
  });

  it('records when and by whom the session was closed, without leaving its temp file behind', () => {
    writeCleanShutdownMarker(appDataDir, { closedAt: '2026-09-29T00:00:00.000Z', pid: 4242 });

    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toEqual({
      closedAt: '2026-09-29T00:00:00.000Z',
      pid: 4242,
    });
    expect(readdirSync(appDataDir)).toEqual(['.db-clean-shutdown']);
  });

  it('replaces an existing marker in place', () => {
    writeCleanShutdownMarker(appDataDir, { closedAt: 'first', pid: 1 });
    writeCleanShutdownMarker(appDataDir, { closedAt: 'second', pid: 2 });

    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toEqual({ closedAt: 'second', pid: 2 });
  });

  it('reads a temp file that never reached its rename as no marker', () => {
    writeFileSync(`${markerPath()}.tmp`, '{"closedAt":"partial"');

    expect(hasCleanShutdownMarker(appDataDir)).toBe(false);
  });

  it('treats removing an absent marker as done', () => {
    expect(() => removeCleanShutdownMarker(appDataDir)).not.toThrow();
  });

  it('surfaces a removal failure other than an absent marker', () => {
    // A directory where the marker belongs cannot be unlinked as a file: an error, never a silent skip.
    mkdirSync(markerPath());

    expect(() => removeCleanShutdownMarker(appDataDir)).toThrow();
    expect(existsSync(markerPath())).toBe(true);
  });

  describe('proving who closed cleanly', () => {
    it('names the pid that wrote the marker', () => {
      writeCleanShutdownMarker(appDataDir, { closedAt: 'now', pid: 4242 });

      expect(cleanShutdownMarkerNamesPid(appDataDir, 4242)).toBe(true);
      expect(cleanShutdownMarkerNamesPid(appDataDir, 1)).toBe(false);
      expect(cleanShutdownMarkerNamesPid(appDataDir, undefined)).toBe(false);
    });

    it('is false, not an error, when there is no marker', () => {
      expect(cleanShutdownMarkerNamesPid(appDataDir, 4242)).toBe(false);
    });

    it.each(['{', '{"closedAt":"now"}', 'null'])(
      'throws for an unreadable marker: %s',
      (contents) => {
        writeFileSync(markerPath(), contents);

        expect(() => cleanShutdownMarkerNamesPid(appDataDir, 4242)).toThrow();
      }
    );
  });

  it('surfaces a write failure', () => {
    expect(() =>
      writeCleanShutdownMarker(path.join(appDataDir, 'missing-directory'), {
        closedAt: 'now',
        pid: 1,
      })
    ).toThrow();
  });
});
