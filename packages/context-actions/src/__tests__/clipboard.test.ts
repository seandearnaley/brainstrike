import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipboardService } from '../clipboard';

interface BridgeResult {
  error?: string;
  ok?: boolean;
}

type MutableWindow = Window & {
  clipboard?: { writeText?: (text: string) => Promise<BridgeResult> } | undefined;
};

const mutableWindow = window as MutableWindow;

afterEach(() => {
  mutableWindow.clipboard = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createClipboardService', () => {
  it('prefers the Electron bridge when present', async () => {
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    mutableWindow.clipboard = { writeText };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('surfaces the bridge error message instead of silently falling back', async () => {
    mutableWindow.clipboard = {
      writeText: vi.fn().mockResolvedValue({ ok: false, error: 'main process rejected write' }),
    };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: false, error: 'main process rejected write' });
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('reports a default error when the bridge fails without a message', async () => {
    mutableWindow.clipboard = { writeText: vi.fn().mockResolvedValue({ ok: false }) };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: false, error: 'Desktop clipboard bridge rejected the write' });
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('reports a malformed bridge result instead of treating it as success', async () => {
    mutableWindow.clipboard = {
      writeText: vi.fn().mockResolvedValue(undefined as unknown as BridgeResult),
    };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: false, error: 'Desktop clipboard bridge rejected the write' });
    expect(navigatorSpy).not.toHaveBeenCalled();
  });

  it('reports an Electron bridge rejection instead of silently falling back', async () => {
    mutableWindow.clipboard = {
      writeText: vi.fn().mockRejectedValue(new Error('bridge exploded')),
    };
    const navigatorSpy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorSpy } });

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome).toEqual({ ok: false, error: 'bridge exploded' });
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

    expect(outcome).toEqual({ ok: false, error: 'denied' });
  });

  it('reports when no clipboard exists at all', async () => {
    vi.stubGlobal('navigator', {});

    const outcome = await createClipboardService().writeText('hello');

    expect(outcome.ok).toBe(false);
  });
});
