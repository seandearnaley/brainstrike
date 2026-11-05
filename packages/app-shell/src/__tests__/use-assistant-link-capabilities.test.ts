import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { AssistantLinkChoices } from '@brainstrike/assistant-ui';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBridge } from '../browser-pane/browser-bridge';
import { canvasWorkspaceTabId } from '../canvas/canvas-workspace-tab';
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
    useAssistantThreadStore.setState({ activeThreadIdByResourceId: {} });
    usePanelLayoutStore.getState().setActiveTab('explorer');
  });

  it('opens a canvas:// link in that canvas\u2019s own tab on the active thread, never in the OS browser', async () => {
    const openExternal = vi.fn();
    setPlatform(fullBridge({ openExternal }));
    usePanelLayoutStore.getState().setActiveTab('settings');
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());

    await expect(
      result.current.openLink('canvas://019a0b3c-4d5e-7f60-8a1b-2c3d4e5f6071')
    ).resolves.toEqual({ ok: true });
    // Mutation: falling through to openExternalLink calls the bridge and toasts
    // "Blocked protocol: canvas:".
    expect(openExternal).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: canvasWorkspaceTabId({
        canvasId: '019a0b3c-4d5e-7f60-8a1b-2c3d4e5f6071',
        threadId: 'thread-1',
      }),
      kind: 'app',
    });
    // The workspace panel only exists on the explorer route (same pairing as
    // the "→ Review" link).
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('reports a canvas link with no thread to open it in', async () => {
    setPlatform(fullBridge());

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('canvas://019a0b3c-4d5e-7f60-8a1b-2c3d4e5f6071');

    expect(outcome).toEqual({ error: 'Open the canvas from its thread', ok: false });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
  });

  it('reports a malformed canvas link instead of failing silently', async () => {
    setPlatform(fullBridge());
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('canvas://');

    expect(outcome).toEqual({ error: 'Canvas link has no usable canvas id', ok: false });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual(['context-explorer']);
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

  it('does not leave a dangling separator when the href is empty', async () => {
    // react-markdown hands us '' for a sanitized-away `javascript:` URL, and
    // MarkdownLink routes it here rather than dying silently. "<reason> — "
    // with nothing after the dash reads like a rendering bug.
    setPlatform(undefined);

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    await result.current.openLink('');

    const [payload] = toastMock.mock.calls[0] as [{ description?: string }];
    expect(payload.description).not.toMatch(/[—-]\s*$/u);
    expect(payload.description).toMatch(/absolute url/iu);
  });

  it('does not reject when the bridge returns an unstringifiable error field', async () => {
    // normalizeBridgeResult validated `ok` but trusted `error`, which the host
    // then interpolated into the toast string. A null-prototype object there
    // threw inside the template literal — rejecting the seam, skipping the
    // toast, and restoring the dead click through a different door.
    const openExternal = vi.fn().mockResolvedValue({
      error: Object.create(null) as string,
      ok: false,
    });
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const outcome = await result.current.openLink('https://example.com/docs');

    expect(outcome.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the toast itself throws', async () => {
    toastMock.mockImplementationOnce(() => {
      throw new Error('toast host exploded');
    });
    const openExternal = vi.fn().mockResolvedValue({ error: 'nope', ok: false });
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());

    // The contract is stated absolutely, so it must hold even when the only
    // thing left to fail is the failure reporter.
    await expect(result.current.openLink('https://example.com/docs')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('tells the user WHY the link did not open', async () => {
    const openExternal = vi.fn();
    setPlatform(fullBridge({ openExternal }));

    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    await result.current.openLink('packages/utils/src/foo.ts');

    const [payload] = toastMock.mock.calls[0] as [{ description?: string }];
    // "Could not open link" plus a bare URL leaves the user guessing between an
    // unsupported protocol, a relative path, and a platform failure.
    expect(payload.description).toMatch(/absolute url/iu);
  });

  it('keeps a stable identity across renders so memoized markdown does not remount', () => {
    setPlatform(fullBridge());

    const { result, rerender } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});

describe('link choices with the built-in browser', () => {
  const browser = {
    closeTab: vi.fn(() => Promise.resolve()),
    createTab: vi.fn(() => Promise.resolve('page-1')),
    goBack: vi.fn(() => Promise.resolve()),
    goForward: vi.fn(() => Promise.resolve()),
    listTabs: vi.fn(() => Promise.resolve([])),
    navigate: vi.fn(() => Promise.resolve()),
    onTabsChanged: vi.fn(() => () => undefined),
    reload: vi.fn(() => Promise.resolve()),
    setBounds: vi.fn(() => Promise.resolve()),
    setOccluded: vi.fn(() => Promise.resolve()),
    showTab: vi.fn(() => Promise.resolve()),
  } satisfies BrowserBridge;
  const writeText = vi.fn((_text: string) => Promise.resolve());

  function choices(): AssistantLinkChoices {
    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    const offered = result.current.linkChoices;
    if (!offered) {
      throw new Error('no link choices');
    }
    return offered;
  }

  beforeEach(() => {
    Object.assign(window, { browser });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'browser');
    Reflect.deleteProperty(navigator, 'clipboard');
    useAssistantThreadStore.setState({ activeThreadIdByResourceId: {} });
    vi.clearAllMocks();
  });

  it('offers only web links, and nothing at all without the built-in browser', () => {
    const offered = choices();
    expect(offered.offers('https://example.com/docs')).toBe(true);
    expect(offered.offers('http://localhost:5173/')).toBe(true);
    expect(offered.offers('mailto:team@example.com')).toBe(false);
    expect(offered.offers('docs/readme.md')).toBe(false);

    Reflect.deleteProperty(window, 'browser');
    const { result } = renderHook(() => useAssistantLinkCapabilitiesValue());
    expect(result.current.linkChoices).toBeUndefined();
  });

  it("opens a web link as a page in the shown conversation's workspace", async () => {
    usePanelLayoutStore.getState().setActiveTab('settings');

    await expect(choices().openInAppBrowser('https://example.com/docs')).resolves.toEqual({
      ok: true,
    });

    expect(browser.createTab).toHaveBeenCalledExactlyOnceWith(
      'thread-1',
      'https://example.com/docs'
    );
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('says why a link could not open in the built-in browser', async () => {
    const offered = choices();
    useAssistantThreadStore.setState({ activeThreadIdByResourceId: {} });

    const result = await offered.openInAppBrowser('https://example.com/docs');

    expect(result.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        description: expect.stringMatching(/Send a message first/u),
        title: 'Could not open link',
        variant: 'destructive',
      })
    );
    expect(browser.createTab).not.toHaveBeenCalled();
  });

  it('copies a link and confirms it, or says why it could not', async () => {
    const offered = choices();

    await expect(offered.copyLink('https://example.com/docs')).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
    expect(toastMock).toHaveBeenCalledExactlyOnceWith({ title: 'Link copied' });

    toastMock.mockClear();
    writeText.mockRejectedValueOnce(new Error('clipboard blocked'));
    const failed = await offered.copyLink('https://example.com/docs');

    expect(failed.ok).toBe(false);
    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: 'Could not copy link', variant: 'destructive' })
    );
  });
});
