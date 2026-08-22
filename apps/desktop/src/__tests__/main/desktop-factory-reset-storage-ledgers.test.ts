import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopApplicationData } from '../../desktop-factory-reset';

// The reset reports its outcome at warn level. Capturing the logger keeps the
// suite's output pristine AND turns "the wipe was reported" into an assertion.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

/**
 * FACTORY RESET CONTRACT pin for the MAIN-PROCESS grant ledgers (BST-1395,
 * sibling of the BST-1061 python-runtime pin in `desktop-factory-reset.test.ts`).
 *
 * `ElectronStorageAdapter` keeps every main-owned key in ONE
 * `electron-storage.json` under `app.getPath('userData')`, so the ledgers have
 * no dedicated reset wiring — the wholesale userData wipe is the whole
 * mechanism. That makes the coverage invisible in the code and easy to lose:
 * add `electron-storage.json` to `PRESERVED_USER_DATA_ENTRY_NAMES`, or move
 * the store outside userData, and a "fresh start" silently keeps handing the
 * composer workspace bar's Recents list picker-less `fs:addRootByPath` grants
 * for folders the user never granted this install.
 *
 * Unlike the sibling suite this runs against REAL fs in a REAL temp dir: a
 * mocked `rename`/`rm` would only prove the calls were issued, and the claim
 * being pinned is that the ledger BYTES are gone afterwards.
 */
describe('resetDesktopApplicationData — main-process storage grant ledgers', () => {
  let userDataPath: string;

  beforeEach(() => {
    loggerMock.warn.mockClear();
    userDataPath = mkdtempSync(path.join(tmpdir(), 'bst-reset-ledgers-'));
  });

  afterEach(() => {
    rmSync(userDataPath, { force: true, recursive: true });
  });

  it('deletes electron-storage.json, taking the recent-roots grant ledgers with it', async () => {
    const storePath = path.join(userDataPath, 'electron-storage.json');
    writeFileSync(
      storePath,
      JSON.stringify({
        // Every main-owned grant key enumerated in platform-contracts.md.
        lastFolderPath: '/granted/alpha',
        notesVaultRoots: JSON.stringify([{ path: '/granted/vault' }]),
        recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: '/granted/alpha' }]),
        'recentRootsList.corrupt': 'not-json-at-all',
        rootsList: JSON.stringify([{ addedAt: 1, path: '/granted/alpha', rootId: 'r1' }]),
        'rootsList.corrupt': 'also-not-json',
      }),
      'utf8'
    );
    mkdirSync(path.join(userDataPath, 'logs'), { recursive: true });
    writeFileSync(path.join(userDataPath, 'logs', 'main.log'), 'kept\n', 'utf8');

    const result = await resetDesktopApplicationData({
      resetDatabaseProfile: vi.fn(async () => undefined),
      stopBackgroundRuntimes: vi.fn(async () => undefined),
      userDataPath,
    });

    expect(existsSync(storePath)).toBe(false);
    expect(result.deletedPaths).toContain(storePath);
    expect(result.pendingDeletionPaths).toEqual([]);
    // `logs` is the ONLY preserved entry; the store must not join it.
    expect(result.preservedPaths).toEqual([path.join(userDataPath, 'logs')]);
    expect(readdirSync(userDataPath)).toEqual(['logs']);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Desktop application data reset completed',
      expect.objectContaining({ deletedPaths: [storePath] })
    );
  });
});
