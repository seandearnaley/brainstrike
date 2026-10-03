import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConnection, sqliteVecExtensionPath } from '../src/index.js';
import { unpackedExtensionPath } from '../src/open-connection.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sqlite-native-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const extensionFile = 'vec0.so';
const packageDirectory = join('node_modules', 'sqlite-vec-linux-x64');

describe('unpackedExtensionPath', () => {
  it('rewrites the app.asar segment to app.asar.unpacked when that file exists', () => {
    const unpacked = join(root, 'app.asar.unpacked', packageDirectory, extensionFile);
    mkdirSync(join(root, 'app.asar.unpacked', packageDirectory), { recursive: true });
    writeFileSync(unpacked, 'not a real library');

    const resolved = join(root, 'app.asar', packageDirectory, extensionFile);

    expect(unpackedExtensionPath(resolved)).toBe(unpacked);
  });

  it('throws, naming both paths, when the unpacked file is missing', () => {
    const resolved = join(root, 'app.asar', packageDirectory, extensionFile);
    const unpacked = join(root, 'app.asar.unpacked', packageDirectory, extensionFile);

    expect(() => unpackedExtensionPath(resolved)).toThrow(
      `sqlite-vec extension is not asarUnpacked: ${unpacked} does not exist (resolved ${resolved})`
    );
  });

  it('does not hand back the asar path even though it looks present to a patched fs', () => {
    // The asar-side file exists on disk here, standing in for Electron's
    // virtual asar entry that existsSync reports as present but dlopen cannot
    // load. The mapping must still demand the unpacked file.
    mkdirSync(join(root, 'app.asar', packageDirectory), { recursive: true });
    const resolved = join(root, 'app.asar', packageDirectory, extensionFile);
    writeFileSync(resolved, 'not a real library');

    expect(() => unpackedExtensionPath(resolved)).toThrow('is not asarUnpacked');
  });

  it('returns a path outside any asar unchanged, without requiring it to exist', () => {
    const resolved = join(root, packageDirectory, extensionFile);

    expect(unpackedExtensionPath(resolved)).toBe(resolved);
  });

  it('rewrites a whole app.asar segment only', () => {
    const resolved = join(root, 'my-app.asar', packageDirectory, extensionFile);

    expect(unpackedExtensionPath(resolved)).toBe(resolved);
  });
});

describe('sqliteVecExtensionPath', () => {
  it('resolves this platform vec0 library outside any asar under Node', () => {
    const resolved = sqliteVecExtensionPath();

    expect(basename(resolved)).toMatch(/^vec0\.(dylib|so|dll)$/);
    expect(resolved).not.toContain('app.asar');
  });
});

describe('openConnection against the real prebuilds', () => {
  it('loads better-sqlite3 and sqlite-vec and reports the vec0 version', () => {
    const db = openConnection(join(root, 'version.db'));
    try {
      const row = db.prepare('select vec_version() as version').get();

      expect(row).toEqual({ version: expect.stringMatching(/^v\d+\.\d+\.\d+/) });
    } finally {
      db.close();
    }
  });

  it('round-trips vectors through a vec0 table, ids as BigInt', () => {
    const db = openConnection(join(root, 'roundtrip.db'));
    try {
      db.exec('create virtual table items using vec0(id integer primary key, embedding float[4])');
      const insert = db.prepare('insert into items(id, embedding) values (?, ?)');
      insert.run(1n, Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
      insert.run(2n, Buffer.from(new Float32Array([0, 1, 0, 0]).buffer));

      const nearest = db
        .prepare('select id, distance from items where embedding match ? and k = 1')
        .get(Buffer.from(new Float32Array([0.9, 0.1, 0, 0]).buffer));

      expect(nearest).toEqual({ distance: expect.any(Number), id: 1 });
    } finally {
      db.close();
    }
  });

  it('forwards options to better-sqlite3', () => {
    expect(() => openConnection(join(root, 'absent.db'), { fileMustExist: true })).toThrow(
      /unable to open database file/
    );
  });
});
