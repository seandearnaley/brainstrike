import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers } from '../ipc-shell-handlers';

function makeShell() {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  };
}

function makeStatPath() {
  return vi.fn().mockResolvedValue({ isDirectory: () => false, isFile: () => true });
}

function makeHandlers(
  shell = makeShell(),
  paths: { lstatPath?: ReturnType<typeof vi.fn>; statPath?: ReturnType<typeof vi.fn> } = {}
) {
  return createShellIpcHandlers({
    lstatPath: paths.lstatPath ?? makeStatPath(),
    shell,
    statPath: paths.statPath ?? makeStatPath(),
  });
}

describe('shell IPC handlers', () => {
  it('reveals a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = makeHandlers(shell);
    const result = await handlers.showItemInFolder('/Users/dev/project/file.ts');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/dev/project/file.ts');
    expect(result).toEqual({ ok: true });
  });

  it('rejects missing shell targets before invoking Electron shell', async () => {
    const shell = makeShell();
    const statPath = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const handlers = makeHandlers(shell, { lstatPath: statPath, statPath });

    const openResult = await handlers.openPath('/Users/dev/missing.pdf');
    const revealResult = await handlers.showItemInFolder('/Users/dev/missing.pdf');

    expect(openResult).toEqual({ error: 'Shell target path does not exist', ok: false });
    expect(revealResult).toEqual({ error: 'Shell target path does not exist', ok: false });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals a dangling symlink entry without requiring its target to exist', async () => {
    const shell = makeShell();
    const statPath = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('dangling'), { code: 'ENOENT' }));
    const lstatPath = vi.fn().mockResolvedValue({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
    });
    const handlers = makeHandlers(shell, { lstatPath, statPath });

    const result = await handlers.showItemInFolder('/Users/dev/project/broken-link');

    expect(result).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/dev/project/broken-link');
    expect(statPath).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '   ',
    'relative/path.ts',
    42,
    null,
    undefined,
    { path: '/x' },
  ])('rejects invalid showItemInFolder payload %p without touching shell', async (payload) => {
    const shell = makeShell();
    const handlers = makeHandlers(shell);
    const result = await handlers.showItemInFolder(payload);
    expect(result.ok).toBe(false);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '   ',
    'relative/path.ts',
    42,
    null,
    undefined,
    { path: '/x' },
  ])('rejects invalid openPath payload %p without touching shell', async (payload) => {
    const shell = makeShell();
    const handlers = makeHandlers(shell);
    const result = await handlers.openPath(payload);
    expect(result.ok).toBe(false);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('propagates shell.openPath error strings as failures', async () => {
    const shell = makeShell();
    shell.openPath.mockResolvedValue('No application found');
    const handlers = makeHandlers(shell);
    const result = await handlers.openPath('/Users/dev/file.xyz');
    expect(result).toEqual({ error: 'No application found', ok: false });
  });

  it('opens a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = makeHandlers(shell);
    const result = await handlers.openPath('/Users/dev/file.pdf');
    expect(shell.openPath).toHaveBeenCalledWith('/Users/dev/file.pdf');
    expect(result).toEqual({ ok: true });
  });

  it('converts a throwing shell.showItemInFolder into a structured failure', async () => {
    const shell = makeShell();
    shell.showItemInFolder.mockImplementation(() => {
      throw new Error('shell unavailable');
    });
    const handlers = makeHandlers(shell);
    const result = await handlers.showItemInFolder('/Users/dev/project/file.ts');
    expect(result).toEqual({ error: 'shell unavailable', ok: false });
  });

  it('converts a rejecting shell.openPath into a structured failure', async () => {
    const shell = makeShell();
    shell.openPath.mockRejectedValue(new Error('open failed'));
    const handlers = makeHandlers(shell);
    const result = await handlers.openPath('/Users/dev/file.pdf');
    expect(result).toEqual({ error: 'open failed', ok: false });
  });
});
