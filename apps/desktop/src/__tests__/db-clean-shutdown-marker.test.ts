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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsFault = vi.hoisted(() => ({ failFsyncOnce: false, failTemporaryUnlink: false }));
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const faulty = {
    ...actual,
    fsyncSync: (descriptor: number) => {
      if (fsFault.failFsyncOnce) {
        fsFault.failFsyncOnce = false;
        throw Object.assign(new Error('fsync failed'), { code: 'EIO' });
      }
      actual.fsyncSync(descriptor);
    },
    unlinkSync: (target: string) => {
      if (fsFault.failTemporaryUnlink && String(target).endsWith('.tmp')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      actual.unlinkSync(target);
    },
  };
  return { ...faulty, default: faulty };
});

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

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
    fsFault.failFsyncOnce = false;
    fsFault.failTemporaryUnlink = false;
    loggerWarnMock.mockReset();
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

  it('does not take a directory at the marker path for a marker', () => {
    mkdirSync(markerPath());

    expect(hasCleanShutdownMarker(appDataDir)).toBe(false);
  });

  it('removes its temp file, and surfaces the failure, when flushing the temp file fails', () => {
    fsFault.failFsyncOnce = true;

    expect(() => writeCleanShutdownMarker(appDataDir, { closedAt: 'now', pid: 1 })).toThrow(
      'fsync failed'
    );

    expect(existsSync(`${markerPath()}.tmp`)).toBe(false);
    expect(hasCleanShutdownMarker(appDataDir)).toBe(false);
  });

  describe('when the rename fails', () => {
    // A directory where the marker belongs makes the rename fail, after the temp file was written.
    const failTheRename = (): void => {
      mkdirSync(markerPath());
      expect(() => writeCleanShutdownMarker(appDataDir, { closedAt: 'now', pid: 1 })).toThrow();
    };

    it('surfaces the failure and does not leave its temp file behind', () => {
      failTheRename();

      expect(existsSync(`${markerPath()}.tmp`)).toBe(false);
    });

    it('logs at warn, and still surfaces the rename failure, when the temp file cannot be removed', () => {
      fsFault.failTemporaryUnlink = true;

      failTheRename();

      expect(existsSync(`${markerPath()}.tmp`)).toBe(true);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        'Could not remove the temporary clean-shutdown marker',
        expect.objectContaining({ error: expect.objectContaining({ code: 'EACCES' }) })
      );
    });
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
