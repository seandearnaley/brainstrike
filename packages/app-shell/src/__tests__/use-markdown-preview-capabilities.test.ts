import { configureLogger, resetLogger } from '@brainstrike/logging';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform-bridge';
import { useMarkdownPreviewCapabilitiesValue } from '../use-markdown-preview-capabilities';

const setPlatform = (bridge: Partial<PlatformBridge> | undefined) => {
  (window as unknown as { platform?: Partial<PlatformBridge> | undefined }).platform = bridge;
};

/** A fully-formed bridge (the resolver rejects anything partial wholesale). */
const fullBridge = (overrides?: Partial<PlatformBridge>): PlatformBridge => ({
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  ...overrides,
});

describe('useMarkdownPreviewCapabilitiesValue', () => {
  afterEach(() => {
    setPlatform(undefined);
    resetLogger();
    vi.restoreAllMocks();
  });

  it('routes external links through window.platform.openExternal when the bridge exists', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    setPlatform(fullBridge({ openExternal }));
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.openExternalLink('https://example.com')).resolves.toEqual({
      ok: true,
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('rejects disallowed protocols before any bridge call', async () => {
    const openExternal = vi.fn();
    setPlatform(fullBridge({ openExternal }));
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

  it('treats a malformed bridge as absent (web fallback, no partial desktop behavior)', async () => {
    configureLogger({ console: false });
    // Missing openPath + showItemInFolder → the resolver disables the WHOLE
    // bridge (exact-set contract; no optional bridge methods).
    const openExternal = vi.fn();
    setPlatform({ openExternal });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await result.current.openExternalLink('https://example.com');
    expect(openExternal).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalled();
  });

  it('resolveImageSrc rejects with a clear reason when no image capability exists', async () => {
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/a.png')).rejects.toThrow(/unavailable/i);
  });

  it('builds a brainstrike-asset URL on desktop', async () => {
    setPlatform(fullBridge());
    const { result } = renderHook(() => useMarkdownPreviewCapabilitiesValue());
    await expect(result.current.resolveImageSrc('/root/img with space.png')).resolves.toBe(
      `brainstrike-asset://local/asset?path=${encodeURIComponent('/root/img with space.png')}`
    );
  });
});
