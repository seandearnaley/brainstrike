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
    setPlatform(undefined);
    // Per HTML spec step 18, `window.open` with `noopener` + `_blank` returns
    // null even when the window opened. The return value therefore carries no
    // success/failure information and must NOT be read as one. (A blocked
    // popup also returns null rather than throwing, so blocking is genuinely
    // unobservable here — accepted, since these run under user activation.)
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

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

  // Defense in depth: browsers signal a blocked popup with null, not a throw,
  // so this path is rare — but the seam must not reject on any of them.
  it('surfaces a window.open throw rather than reporting success', async () => {
    setPlatform(undefined);
    vi.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does not turn a rejecting desktop bridge back into a dead click', async () => {
    // An IPC channel torn down mid-call REJECTS; it does not resolve
    // { ok: false }. If that rejection escapes, the toast never runs and the
    // user gets exactly the silent dead click this whole change removes.
    const openExternal = vi.fn().mockRejectedValue(new Error('IPC channel closed'));
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the bridge resolves an unexpected shape', async () => {
    // The bridge answer crosses IPC, so it is untyped data at runtime. An
    // undefined or mangled payload used to make `result.ok` throw, which
    // rejected `openLink`, skipped the toast, and restored the dead click.
    const openExternal = vi.fn().mockResolvedValue(undefined);
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the bridge throws a value that cannot be stringified', async () => {
    const hostile = Object.create(null) as Record<string, never>;
    const openExternal = vi.fn().mockRejectedValue(hostile);
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('tells the user WHY the link did not open', async () => {
    const openExternal = vi.fn();
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    await result.current.openLink('packages/utils/src/foo.ts');

    const [payload] = toastMock.mock.calls[0] as [{ description?: string }];
    // "Could not open link" plus a bare URL leaves the user guessing between an
    // unsupported protocol, a relative path, and a platform failure.
    expect(payload.description).toMatch(/absolute url/i);
  });

  it('keeps a stable identity across renders so memoized markdown does not remount', () => {
    setPlatform(fullBridge());

    const { result, rerender } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
