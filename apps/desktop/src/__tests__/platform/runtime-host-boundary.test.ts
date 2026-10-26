import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationIpcDomain } from '../../ipc-handlers';

const ipcOwners = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  files: vi.fn(async () => undefined),
  path: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  storage: vi.fn(async () => undefined),
  watch: vi.fn(async () => undefined),
}));
vi.mock('../../ipc-domains/file-system-ipc', () => ({
  createFileSystemIpcDomain: vi.fn(() => ({ close: ipcOwners.files, roots: {} })),
}));
vi.mock('../../ipc-domains/file-system-watch-ipc', () => ({
  registerFileSystemWatchIpcHandlers: vi.fn(() => ipcOwners.watch),
}));
vi.mock('../../ipc-domains/storage-preferences-ipc', () => ({
  registerStoragePreferencesIpcHandlers: vi.fn(() => ipcOwners.storage),
}));
vi.mock('../../ipc-factory-reset', () => ({
  registerContentClearIpcHandlers: vi.fn(() => ipcOwners.clear),
  registerFactoryResetIpcHandlers: vi.fn(() => ipcOwners.reset),
  registerProfilePathIpcHandlers: vi.fn(() => ipcOwners.path),
}));

function readDesktopSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

function readDesktopE2e(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'e2e', relativePath), 'utf8');
}

describe('runtime host boundary', () => {
  it('joins every owned application IPC domain even when one retirement fails', async () => {
    const failure = new Error('Source lease retirement failed');
    ipcOwners.files.mockRejectedValueOnce(failure);
    const domain = createApplicationIpcDomain(
      {} as Parameters<typeof createApplicationIpcDomain>[0],
      {} as Parameters<typeof createApplicationIpcDomain>[1],
      () => null,
      {
        getRootsCatalog: async () => {
          throw new Error('Unexpected catalog read during registration');
        },
        getUserDataPath: () => '/disposable/profile',
        onClearContent: async () => {
          throw new Error('Unexpected content clear');
        },
        onResetLocal: async () => ({ success: true }),
      }
    );
    await expect(domain.close()).rejects.toMatchObject({ errors: [failure] });
    for (const owner of Object.values(ipcOwners)) {
      expect(owner).toHaveBeenCalledOnce();
    }
  });

  it('keeps main process startup free of ad hoc IPC registration', () => {
    const source = readDesktopSource('main.ts');

    expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
    expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
  });

  it('keeps desktop file explorer selection E2E executable specs split by purpose', () => {
    const interactiveSpec = readDesktopE2e('file-explorer-selection.desktop.test.ts');
    const restoreSpec = readDesktopE2e('file-explorer-selection-restore.desktop.test.ts');
    const sharedHarness = readDesktopE2e('README.md');

    expect(interactiveSpec.split('\n').length).toBeLessThanOrEqual(2000);
    expect(restoreSpec.split('\n').length).toBeLessThanOrEqual(2000);
    expect(sharedHarness).toMatch(/file-explorer-selection\.shared\.ts/);
    expect(sharedHarness).toMatch(/test fixture\s+exception/);
  });
});
