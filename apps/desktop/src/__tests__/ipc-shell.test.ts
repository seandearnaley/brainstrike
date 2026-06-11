import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers } from '../ipc-shell-handlers';

function makeShell() {
  return {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  };
}

describe('shell IPC handlers', () => {
  it('reveals a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.showItemInFolder('/Users/dev/project/file.ts');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/Users/dev/project/file.ts');
    expect(result).toEqual({ ok: true });
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
    const handlers = createShellIpcHandlers({ shell });
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
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath(payload);
    expect(result.ok).toBe(false);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('propagates shell.openPath error strings as failures', async () => {
    const shell = makeShell();
    shell.openPath.mockResolvedValue('No application found');
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath('/Users/dev/file.xyz');
    expect(result).toEqual({ ok: false, error: 'No application found' });
  });

  it('opens a valid absolute path', async () => {
    const shell = makeShell();
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath('/Users/dev/file.pdf');
    expect(shell.openPath).toHaveBeenCalledWith('/Users/dev/file.pdf');
    expect(result).toEqual({ ok: true });
  });

  it('converts a throwing shell.showItemInFolder into a structured failure', async () => {
    const shell = makeShell();
    shell.showItemInFolder.mockImplementation(() => {
      throw new Error('shell unavailable');
    });
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.showItemInFolder('/Users/dev/project/file.ts');
    expect(result).toEqual({ ok: false, error: 'shell unavailable' });
  });

  it('converts a rejecting shell.openPath into a structured failure', async () => {
    const shell = makeShell();
    shell.openPath.mockRejectedValue(new Error('open failed'));
    const handlers = createShellIpcHandlers({ shell });
    const result = await handlers.openPath('/Users/dev/file.pdf');
    expect(result).toEqual({ ok: false, error: 'open failed' });
  });
});
