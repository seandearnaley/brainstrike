import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../platform-bridge';
import { useAssistantLinkCapabilitiesValue } from '../use-assistant-link-capabilities';

const toastMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastMock,
}));

const setPlatform = (bridge: Partial<PlatformBridge> | undefined) => {
  (window as unknown as { platform?: Partial<PlatformBridge> | undefined }).platform = bridge;
};

/** A fully-formed bridge (the resolver rejects anything partial wholesale). */
const fullBridge = (overrides?: Partial<PlatformBridge>): PlatformBridge => ({
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  ...overrides,
});

describe('useAssistantLinkCapabilitiesValue', () => {
  afterEach(() => {
    setPlatform(undefined);
    toastMock.mockClear();
    vi.restoreAllMocks();
  });

  it('opens an http link through the desktop bridge', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true });
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());

    await expect(result.current.openLink('https://example.com/docs')).resolves.toEqual({
      ok: true,
    });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('opens an http link with window.open on web', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());

    await expect(result.current.openLink('https://example.com/docs')).resolves.toEqual({
      ok: true,
    });
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it('reports a workspace-relative link as unsupported instead of failing silently', async () => {
    const openExternal = vi.fn();
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('packages/utils/src/foo.ts');

    expect(outcome.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    // The seam's whole point: the user learns why nothing opened.
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('toasts when the platform refuses to open a well-formed link', async () => {
    const openExternal = vi.fn().mockResolvedValue({ error: 'nope', ok: false });
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('toasts when a popup blocker swallows the web link', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable identity across renders so memoized markdown does not remount', () => {
    setPlatform(fullBridge());

    const { result, rerender } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
