import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipboardService } from '../clipboard.js';

type MutableWindow = Window & {
  clipboard?: { writeText?: (text: string) => Promise<BoundaryResult<void>> } | undefined;
};

const mutableWindow = window as MutableWindow;

afterEach(() => {
  mutableWindow.clipboard = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createClipboardService', () => {
  it('prefers the Electron bridge when present', async () => {
    const writeText = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    mutableWindow.clipboard = { writeText };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('surfaces the unwrapped bridge failure message instead of silently falling back', async () => {
    mutableWindow.clipboard = {
      writeText: vi.fn().mockResolvedValue({
        error: {
          category: 'availability',
          code: 'clipboard.unavailable',
          kind: 'refusal',
          message: 'Clipboard is unavailable.',
          remedy: 'Try again.',
        },
        ok: false,
      }),
    };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ error: 'Clipboard is unavailable. Try again.', ok: false });
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('reports an Electron bridge rejection instead of silently falling back', async () => {
    mutableWindow.clipboard = {
      writeText: vi.fn().mockRejectedValue(new Error('bridge exploded')),
    };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ error: INTERNAL_FAULT.message, ok: false });
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('uses navigator.clipboard when no Electron bridge exists', async () => {
    const navigatorSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: true });
    expect(navigatorSpy).toHaveBeenCalledWith('hello');
  });

  it('reports navigator.clipboard rejections', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ error: 'denied', ok: false });
  });

  it('reports when no clipboard exists at all', async () => {
    vi.stubGlobal('navigator', {});

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome.ok).toBe(false);
  });
});

describe('createClipboardService().writeImage', () => {
  const png = () =>
    Promise.resolve(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));

  it('sends the PNG bytes through the Electron bridge when present', async () => {
    const writeImage = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    (window as unknown as { clipboard: unknown }).clipboard = { writeImage, writeText: vi.fn() };
    const navigatorWrite = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { write: navigatorWrite } });

    const outcome = await createClipboardService().writeImage(png());

    expect(outcome).toEqual({ ok: true });
    expect(writeImage).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]));
    expect(navigatorWrite).not.toHaveBeenCalled();
  });

  it('reports a desktop bridge that cannot take images instead of using the web API', async () => {
    (window as unknown as { clipboard: unknown }).clipboard = { writeText: vi.fn() };
    const navigatorWrite = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { write: navigatorWrite } });

    const outcome = await createClipboardService().writeImage(png());

    expect(outcome.ok).toBe(false);
    expect(navigatorWrite).not.toHaveBeenCalled();
  });

  it('reports an image that failed to draw', async () => {
    const writeImage = vi.fn();
    (window as unknown as { clipboard: unknown }).clipboard = { writeImage };

    const outcome = await createClipboardService().writeImage(
      Promise.reject(new Error('Canvas is too large'))
    );

    expect(outcome).toEqual({ error: 'Canvas is too large', ok: false });
    expect(writeImage).not.toHaveBeenCalled();
  });

  it('writes a PNG ClipboardItem through navigator.clipboard on web', async () => {
    const navigatorWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { write: navigatorWrite } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        readonly items: Record<string, unknown>;
        constructor(items: Record<string, unknown>) {
          this.items = items;
        }
      }
    );

    const outcome = await createClipboardService().writeImage(png());

    expect(outcome).toEqual({ ok: true });
    expect(Object.keys(navigatorWrite.mock.calls[0]?.[0][0].items)).toEqual(['image/png']);
  });
});
