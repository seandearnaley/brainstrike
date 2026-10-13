import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { describe, expect, it, vi } from 'vitest';
import { createClipboardIpcHandlers } from '../ipc-clipboard-handlers';

function makeClipboard() {
  return {
    writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

// Payload validation lives in the contract's parseArgs (leaf-contracts.test.ts):
// these handlers only ever see a string.
describe('clipboard IPC handlers', () => {
  it('writes a string payload to the system clipboard', async () => {
    const clipboard = makeClipboard();
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = await handlers.writeText('docs/notes.ts');
    expect(clipboard.writeText).toHaveBeenCalledWith('docs/notes.ts');
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('writes an empty string without rejecting it', async () => {
    const clipboard = makeClipboard();
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = await handlers.writeText('');
    expect(clipboard.writeText).toHaveBeenCalledWith('');
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('surfaces a clipboard write throw as the IpcResult failure taxonomy', async () => {
    const clipboard = makeClipboard();
    clipboard.writeText.mockImplementation(() => {
      throw new Error('clipboard locked');
    });
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = await handlers.writeText('hello');
    expect(result).toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
  });

  it('awaits a rejected clipboard write and returns the IpcResult failure taxonomy', async () => {
    const clipboard = makeClipboard();
    clipboard.writeText.mockImplementation(() => Promise.reject(new Error('clipboard locked')));
    const handlers = createClipboardIpcHandlers({ clipboard });
    const result = await handlers.writeText('hello');
    expect(result).toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
  });
});
