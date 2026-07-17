import { describe, expect, it, vi } from 'vitest';
import { createShellIpcHandlers, validateExternalUrl } from '../ipc-shell-handlers';

function makeShell() {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  };
}

describe('validateExternalUrl', () => {
  it.each([
    'https://example.com/a?b=1',
    'http://localhost:8080',
    'mailto:a@b.com',
  ])('allows %s', (url) => {
    expect(validateExternalUrl(url)).toEqual({ ok: true, url: expect.any(String) });
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'brainstrike-asset://local/asset?path=/x',
    'ftp://x',
    '',
    'not a url',
  ])('rejects %s', (url) => {
    const r = validateExternalUrl(url);
    expect(r.ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateExternalUrl(42).ok).toBe(false);
    expect(validateExternalUrl(undefined).ok).toBe(false);
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
