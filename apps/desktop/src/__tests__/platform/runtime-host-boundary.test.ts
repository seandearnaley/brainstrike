import { describe, expect, it, vi } from 'vitest';
import { createApplicationIpcDomain } from '../../ipc-handlers';

const ipcOwners = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  files: vi.fn(async () => undefined),
  ledgers: vi.fn(async () => undefined),
  path: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  watch: vi.fn(async () => undefined),
}));
vi.mock('../../ipc-domains/file-system-ipc', () => ({
  createFileSystemIpcDomain: vi.fn(() => ({ close: ipcOwners.files, roots: {} })),
}));
vi.mock('../../ipc-domains/file-system-watch-ipc', () => ({
  registerFileSystemWatchIpcHandlers: vi.fn(() => ipcOwners.watch),
}));
vi.mock('../../ipc-domains/workspace-ledgers-e2e-ipc', () => ({
  registerWorkspaceLedgersE2eHandlers: vi.fn(() => ipcOwners.ledgers),
}));
vi.mock('../../ipc-factory-reset', () => ({
  registerContentClearIpcHandlers: vi.fn(() => ipcOwners.clear),
  registerFactoryResetIpcHandlers: vi.fn(() => ipcOwners.reset),
  registerProfilePathIpcHandlers: vi.fn(() => ipcOwners.path),
}));

describe('runtime host boundary', () => {
  it('joins every owned application IPC domain even when one retirement fails', async () => {
    const failure = new Error('Source lease retirement failed');
    ipcOwners.files.mockRejectedValueOnce(failure);
    const domain = createApplicationIpcDomain(
      {} as Parameters<typeof createApplicationIpcDomain>[0],
      {} as Parameters<typeof createApplicationIpcDomain>[1],
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
});
