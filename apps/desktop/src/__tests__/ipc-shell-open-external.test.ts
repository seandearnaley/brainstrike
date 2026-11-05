import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers } from '../ipc-shell-handlers';

function makeShell() {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  };
}

describe('openExternal URL policy', () => {
  it.each(['https://example.com/a?b=1', 'http://localhost:8080', 'mailto:a@b.com'])(
    'opens %s',
    async (url) => {
      const shell = makeShell();
      await expect(createShellIpcHandlers({ shell }).openExternal(url)).resolves.toEqual({
        ok: true,
      });
      expect(shell.openExternal).toHaveBeenCalledOnce();
    }
  );

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'brainstrike-asset://local/asset?path=/x',
    'ftp://x',
    '',
    'not a url',
  ])('refuses %s without touching shell', async (url) => {
    const shell = makeShell();
    const result = await createShellIpcHandlers({ shell }).openExternal(url);
    expect(result.ok).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('openExternal handler', () => {
  it('calls shell.openExternal only for allowed URLs', async () => {
    const shell = makeShell();
    const handlers = createShellIpcHandlers({ shell });
    await expect(handlers.openExternal('https://example.com/')).resolves.toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/');
    const blocked = await handlers.openExternal('file:///etc/passwd');
    expect(blocked.ok).toBe(false);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('surfaces shell throw as {ok:false}', async () => {
    const shell = makeShell();
    shell.openExternal.mockRejectedValue(new Error('boom'));
    const handlers = createShellIpcHandlers({ shell });
    await expect(handlers.openExternal('https://example.com/')).resolves.toEqual({
      error: 'boom',
      ok: false,
    });
  });
});
