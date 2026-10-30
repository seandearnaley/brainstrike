import { DOWNLOAD_BLOB_REVOKE_DELAY_MS } from '@brainstrike/utils/browser-download';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveDownload } from '../save-download';
import { Toaster } from '../toaster';
import { resetToastStore } from '../use-toast';

/** Hands every `<a>` the page creates to `anchor`; React's other elements stay real. */
function captureAnchors(anchor: HTMLAnchorElement): void {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
    tagName === 'a' ? anchor : create(tagName)) as typeof document.createElement);
}

const markdown = () => ({
  blob: new Blob(['# bundle'], { type: 'text/markdown;charset=utf-8' }),
  filename: 'bundle.md',
});

afterEach(() => {
  Reflect.deleteProperty(window, 'fileExports');
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => resetToastStore());
});

describe('saveDownload', () => {
  it('on desktop, saves over the file-export bridge and names the path it saved at', async () => {
    const saveToDownloads = vi
      .fn()
      .mockResolvedValue({ ok: true, path: '/home/me/Downloads/bundle (1).md' });
    (window as Window & { fileExports?: unknown }).fileExports = { saveToDownloads };
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    render(<Toaster />);

    await act(async () => {
      expect(await saveDownload({ build: markdown, what: 'debug bundle' })).toBe(true);
    });

    const payload = saveToDownloads.mock.calls[0]?.[0] as { bytes: Uint8Array; filename: string };
    expect(payload.filename).toBe('bundle.md');
    expect(new TextDecoder().decode(payload.bytes)).toBe('# bundle');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText('Debug bundle saved')).toBeInTheDocument();
    expect(screen.getByText('/home/me/Downloads/bundle (1).md')).toBeInTheDocument();
  });

  it('on the web, clicks an anchor, keeps its object URL alive past the click, and names the file', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    captureAnchors(anchor);

    await act(async () => {
      await saveDownload({ build: markdown, what: 'debug bundle' });
    });

    const [saved] = createObjectURL.mock.calls[0] ?? [];
    expect((saved as Blob | undefined)?.type).toBe('text/markdown;charset=utf-8');
    expect(anchor.download).toBe('bundle.md');
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Debug bundle saved')).toBeInTheDocument();
    expect(screen.getByText('bundle.md')).toBeInTheDocument();
    // The browser resolves the blob URL after the click returns; revoking it
    // first silently drops the file.
    vi.advanceTimersByTime(DOWNLOAD_BLOB_REVOKE_DELAY_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bundle');
  });

  it('says why a save failed, and frees the object URL at once', async () => {
    render(<Toaster />);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bundle');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(() => {
      throw new Error('click blocked');
    });
    captureAnchors(anchor);

    await act(async () => {
      expect(await saveDownload({ build: markdown, what: 'debug bundle' })).toBe(false);
    });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bundle');
    expect(screen.getByText('Could not save the debug bundle')).toBeInTheDocument();
    expect(screen.getByText('click blocked')).toBeInTheDocument();
    expect(screen.queryByText('Debug bundle saved')).not.toBeInTheDocument();
  });

  it('says why a file could not be built, and saves nothing', async () => {
    const saveToDownloads = vi.fn();
    (window as Window & { fileExports?: unknown }).fileExports = { saveToDownloads };
    render(<Toaster />);

    await act(async () => {
      await saveDownload({
        build: () => Promise.reject(new Error('Database unavailable')),
        what: 'debug pack',
      });
    });

    expect(saveToDownloads).not.toHaveBeenCalled();
    expect(screen.getByText('Could not save the debug pack')).toBeInTheDocument();
    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
  });
});
