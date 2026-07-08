import { describe, expect, it, vi } from 'vitest';
import { createClipboardIpcHandlers } from '../ipc-clipboard-handlers';

function makeClipboard() {
  return {
    writeText: vi.fn(),
  };
}

describe('clipboard IPC handlers', () => {
  it('writes a string payload to the system clipboard', () => {
    const clipboard = makeClipboard();
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = handlers.writeText('docs/notes.ts');
    expect(clipboard.writeText).toHaveBeenCalledWith('docs/notes.ts');
    expect(result).toEqual({ ok: true });
  });

  it('writes an empty string without rejecting it', () => {
    const clipboard = makeClipboard();
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = handlers.writeText('');
    expect(clipboard.writeText).toHaveBeenCalledWith('');
    expect(result).toEqual({ ok: true });
  });

  it.each([
    42,
    null,
    undefined,
    { text: 'x' },
    ['x'],
    true,
  ])('rejects non-string payload %p without touching the clipboard', (payload) => {
    const clipboard = makeClipboard();
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = handlers.writeText(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('string');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('surfaces a clipboard write throw as a structured failure', () => {
    const clipboard = makeClipboard();
    clipboard.writeText.mockImplementation(() => {
      throw new Error('clipboard locked');
    });
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = handlers.writeText('hello');
    expect(result).toEqual({ error: 'clipboard locked', ok: false });
  });
});
