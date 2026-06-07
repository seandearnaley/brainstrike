import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_PG_MAJOR,
  isEngineUpgradeBackupName,
  isIncompatiblePgDataDir,
  isNewerPgDataDir,
  pruneStaleEngineUpgradeBackups,
  readPgDataMajor,
} from '../../pg-data-version';

describe('isEngineUpgradeBackupName', () => {
  it('matches engine-upgrade moved-aside backups', () => {
    expect(isEngineUpgradeBackupName('pgdata.pre-pg18-from-pg17.bak')).toBe(true);
    expect(isEngineUpgradeBackupName('pgdata.pre-pg19-from-pgunknown.bak')).toBe(true);
  });

  it('does not match the live data dir, lock files, or reset snapshots', () => {
    expect(isEngineUpgradeBackupName('pgdata')).toBe(false);
    expect(isEngineUpgradeBackupName('.db-process.lock')).toBe(false);
    expect(isEngineUpgradeBackupName('pgdata.bak')).toBe(false);
    expect(isEngineUpgradeBackupName('some-profile-2026-01-01.bak')).toBe(false);
  });
});

describe('pg-data-version guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bs-pgdata-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePgVersion(major: string): void {
    writeFileSync(path.join(dir, 'PG_VERSION'), `${major}\n`, 'utf8');
  }

  it('targets Postgres 18 as the bundled engine major', () => {
    expect(BUNDLED_PG_MAJOR).toBe('18');
  });

  it('reads the Postgres major from a data dir PG_VERSION file', () => {
    writePgVersion('17');
    expect(readPgDataMajor(dir)).toBe('17');
  });

  it('returns null when the data dir has no PG_VERSION (fresh/empty dir)', () => {
    expect(readPgDataMajor(dir)).toBeNull();
  });

  it('returns null for an empty or whitespace-only PG_VERSION (mid-init/corrupt, not a different major)', () => {
    writePgVersion('   ');
    expect(readPgDataMajor(dir)).toBeNull();
    expect(isIncompatiblePgDataDir(dir)).toBe(false);
  });

  it('flags a PG17 data dir as incompatible with the PG18 engine', () => {
    writePgVersion('17');
    expect(isIncompatiblePgDataDir(dir)).toBe(true);
  });

  it('treats a matching PG18 data dir as compatible', () => {
    writePgVersion('18');
    expect(isIncompatiblePgDataDir(dir)).toBe(false);
  });

  it('treats an empty/fresh data dir as compatible (nothing to wipe)', () => {
    expect(isIncompatiblePgDataDir(dir)).toBe(false);
  });

  it('treats a non-existent data dir as compatible', () => {
    const missing = path.join(dir, 'does-not-exist');
    expect(existsSync(missing)).toBe(false);
    expect(isIncompatiblePgDataDir(missing)).toBe(false);
  });

  it('ignores surrounding whitespace in PG_VERSION', () => {
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'PG_VERSION'), '  18  \n', 'utf8');
    expect(isIncompatiblePgDataDir(path.join(dir, 'nested'))).toBe(false);
  });

  it('flags a NEWER-major data dir (PG19 under a PG18 build) as newer', () => {
    writePgVersion('19');
    expect(isNewerPgDataDir(dir)).toBe(true);
    // A newer dir is still "incompatible" (can't be opened) but must be handled
    // by failing loudly, not wiped — the two predicates partition incompatible.
    expect(isIncompatiblePgDataDir(dir)).toBe(true);
  });

  it('does NOT flag an OLDER-major data dir (PG17) as newer', () => {
    writePgVersion('17');
    expect(isNewerPgDataDir(dir)).toBe(false);
  });

  it('does NOT flag a matching PG18 data dir as newer', () => {
    writePgVersion('18');
    expect(isNewerPgDataDir(dir)).toBe(false);
  });

  it('does NOT flag a fresh/empty data dir as newer (nothing to compare)', () => {
    expect(isNewerPgDataDir(dir)).toBe(false);
  });

  it('does NOT flag a non-numeric PG_VERSION as newer (falls through to wipe path)', () => {
    writePgVersion('garbage');
    expect(isNewerPgDataDir(dir)).toBe(false);
  });
});

describe('pruneStaleEngineUpgradeBackups', () => {
  let appDataDir: string;
  let dataDir: string;

  beforeEach(() => {
    appDataDir = mkdtempSync(path.join(tmpdir(), 'bs-prune-'));
    dataDir = path.join(appDataDir, 'pgdata');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(appDataDir, { recursive: true, force: true });
  });

  function makeBackup(name: string): string {
    const full = path.join(appDataDir, name);
    mkdirSync(full, { recursive: true });
    return full;
  }

  it('removes engine-upgrade backups older than the retention window', () => {
    const stale = makeBackup('pgdata.pre-pg18-from-pg17.bak');
    const olderMajor = makeBackup('pgdata.pre-pg17-from-pg16.bak');
    // Treat "now" as far in the future so the just-created dirs exceed retention.
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;

    const pruned = pruneStaleEngineUpgradeBackups(dataDir, 24 * 60 * 60 * 1000, future);

    expect(pruned.sort()).toEqual([olderMajor, stale].sort());
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(olderMajor)).toBe(false);
  });

  it('keeps a recent backup within the retention window and never touches the live dir', () => {
    const recent = makeBackup('pgdata.pre-pg18-from-pg17.bak');

    const pruned = pruneStaleEngineUpgradeBackups(dataDir, 24 * 60 * 60 * 1000, Date.now());

    expect(pruned).toEqual([]);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
  });

  it('ignores non-backup siblings (the live pgdata dir and unrelated entries)', () => {
    makeBackup('other-dir');
    writeFileSync(path.join(appDataDir, 'pgdata.lock'), 'x', 'utf8');
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;

    const pruned = pruneStaleEngineUpgradeBackups(dataDir, 24 * 60 * 60 * 1000, future);

    expect(pruned).toEqual([]);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(path.join(appDataDir, 'pgdata.lock'))).toBe(true);
  });

  it('never prunes the excluded just-created backup, even when its mtime is already stale', () => {
    // Models the utimes-stamp-failed edge case: a backup moved aside THIS boot whose
    // mtime is the old DB's last-write time (already older than retention). Passing
    // it as excludePath must keep the same-boot prune from collapsing the recovery
    // window to zero — independent of mtime.
    const justMoved = makeBackup('pgdata.pre-pg18-from-pg17.bak');
    const olderOrphan = makeBackup('pgdata.pre-pg17-from-pg16.bak');
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;

    const pruned = pruneStaleEngineUpgradeBackups(dataDir, 24 * 60 * 60 * 1000, future, justMoved);

    // The excluded backup survives; the unrelated stale orphan is still reclaimed.
    expect(pruned).toEqual([olderOrphan]);
    expect(existsSync(justMoved)).toBe(true);
    expect(existsSync(olderOrphan)).toBe(false);
  });
});
