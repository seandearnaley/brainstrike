// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCrashDumps } from '../../diagnostics/crash-dumps';

describe('listCrashDumps', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'brainstrike-crash-dumps-'));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  function writeDump(folder: string, name: string, bytes: number, modifiedAtMs: number): void {
    mkdirSync(path.join(directory, folder), { recursive: true });
    const filePath = path.join(directory, folder, name);
    writeFileSync(filePath, Buffer.alloc(bytes));
    utimesSync(filePath, modifiedAtMs / 1000, modifiedAtMs / 1000);
  }

  it('lists every minidump under the Crashpad folder, newest first, and nothing else', async () => {
    writeDump('completed', 'older.dmp', 10, Date.UTC(2026, 9, 30, 12));
    writeDump('pending', 'newer.dmp', 20, Date.UTC(2026, 9, 31, 1));
    writeFileSync(path.join(directory, 'settings.dat'), 'crashpad settings');
    writeFileSync(path.join(directory, 'completed', 'older.meta'), 'metadata');

    await expect(listCrashDumps(directory)).resolves.toEqual({
      directory,
      dumps: [
        {
          folder: 'pending',
          modifiedAt: '2026-10-31T01:00:00.000Z',
          name: 'newer.dmp',
          sizeBytes: 20,
        },
        {
          folder: 'completed',
          modifiedAt: '2026-10-30T12:00:00.000Z',
          name: 'older.dmp',
          sizeBytes: 10,
        },
      ],
      totalCount: 2,
    });
  });

  it('names the newest twenty and counts the rest', async () => {
    for (let index = 0; index < 25; index += 1) {
      writeDump('completed', `dump-${index}.dmp`, 1, Date.UTC(2026, 9, 1) + index * 60_000);
    }
    const listing = await listCrashDumps(directory);
    expect(listing.totalCount).toBe(25);
    expect(listing.dumps.map((dump) => dump.name)).toEqual(
      Array.from({ length: 20 }, (_, offset) => `dump-${24 - offset}.dmp`)
    );
  });

  it('lists nothing before Crashpad has created its folder', async () => {
    const missing = path.join(directory, 'Crashpad');
    await expect(listCrashDumps(missing)).resolves.toEqual({
      directory: missing,
      dumps: [],
      totalCount: 0,
    });
  });

  it('rejects a folder it cannot read instead of reporting no crashes', async () => {
    const notADirectory = path.join(directory, 'file');
    writeFileSync(notADirectory, '');
    await expect(listCrashDumps(notADirectory)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
