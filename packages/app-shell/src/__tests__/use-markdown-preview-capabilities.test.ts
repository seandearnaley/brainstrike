import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkdownPreviewCapabilitiesValue } from '../use-markdown-preview-capabilities';

interface PlatformBridge {
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}
const setPlatform = (bridge: PlatformBridge | undefined) => {
  (window as unknown as { platform?: PlatformBridge | undefined }).platform = bridge;
};

describe('useMarkdownPreviewCapabilitiesValue', () => {
  afterEach(() => {
    setPlatform(undefined);
    vi.restoreAllMocks();
  });

  it('routes external links through window.platform.openExternal when the bridge exists', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    setPlatform({ openExternal });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.openExternalLink('https://example.com')).resolves.toEqual({
      ok: true,
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('rejects disallowed protocols before any bridge call', async () => {
    const openExternal = vi.fn();
    setPlatform({ openExternal });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    const r = await result.current.openExternalLink('javascript:alert(1)');
    expect(r.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falls back to window.open on web and reports popup blocking', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    const r = await result.current.openExternalLink('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(r.ok).toBe(false);
  });

  it('resolveImageSrc rejects with a clear reason when no image capability exists', async () => {
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/a.png')).rejects.toThrow(/unavailable/i);
  });

  it('builds a brainstrike-asset URL on desktop', async () => {
    setPlatform({ openExternal: vi.fn() });
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/img with space.png')).resolves.toBe(
      `brainstrike-asset://local/asset?path=${encodeURIComponent('/root/img with space.png')}`
    );
  });
});
