import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { Button, Input } from '@brainstrike/ui';
import { ArrowLeft, ArrowRight, Plus, RotateCw, X } from 'lucide-react';
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { resolveBrowserBridge } from './browser-bridge';
import { selectActiveBrowserTab, useBrowserTabsStore } from './browser-tabs-store';

/**
 * The embedded browser pane surface (BST-1174). Renders the chrome — tab
 * strip, URL bar, back/forward — as DOM, and reserves an empty region whose
 * on-screen rect it reports to main so the native `WebContentsView` overlays
 * exactly that box.
 *
 * OCCLUSION (novel — a native view paints above all DOM): the pane must hide
 * whenever it would be covered. Three sources, unified into a single
 * `setOccluded`:
 * 1. this nav-rail route is not the active shell tab (its DOM is
 *    `display:none`, so the reserved region reports a zero rect);
 * 2. the Settings modal is open;
 * 3. the command palette is open.
 * (Smaller transient overlays — toasts, popovers, page context menus — are a
 * documented follow-up; see the ui-conventions native-layer note.)
 */
export function BrowserPaneContent(): ReactElement {
  const bridge = resolveBrowserBridge();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const tabs = useBrowserTabsStore((state) => state.tabs);
  const setTabs = useBrowserTabsStore((state) => state.setTabs);
  const activeTab = useBrowserTabsStore(selectActiveBrowserTab);

  const activeShellTab = usePanelLayoutStore((state) => state.activeTab);
  const settingsOpen = usePanelLayoutStore((state) => state.settingsOpen);
  const paletteOpen = useCommandPaletteStore((state) => state.isOpen);
  const routeActive = activeShellTab === 'browser';
  const occluded = !routeActive || settingsOpen || paletteOpen;

  const [urlDraft, setUrlDraft] = useState('');
  // The URL input follows the active tab's url UNLESS the user is editing.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) {
      setUrlDraft(activeTab?.url ?? '');
    }
  }, [activeTab?.url, editing]);

  // Subscribe to main's tab-state pushes, then seed from the current list.
  // Subscribe FIRST and skip the seed if a push already populated the store,
  // so a push arriving during the seed round-trip is never clobbered by the
  // stale snapshot.
  useEffect(() => {
    if (!bridge) {
      return;
    }
    const unsubscribe = bridge.onTabsChanged(setTabs);
    void bridge.listTabs().then((seed) => {
      if (useBrowserTabsStore.getState().tabs.length === 0) {
        setTabs(seed);
      }
    });
    return unsubscribe;
  }, [bridge, setTabs]);

  // Report bounds (or occlusion) whenever geometry or occlusion changes.
  useEffect(() => {
    const pane = paneRef.current;
    if (!(bridge && pane)) {
      return;
    }
    if (occluded) {
      void bridge.setOccluded(true);
      return;
    }
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = pane.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          void bridge.setOccluded(true);
          return;
        }
        void bridge.setOccluded(false);
        void bridge.setBounds({
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(pane);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
    };
  }, [bridge, occluded]);

  const handleNavigate = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      setEditing(false);
      const trimmed = urlDraft.trim();
      if (!(bridge && trimmed)) {
        return;
      }
      if (activeTab) {
        void bridge.navigate(activeTab.tabId, trimmed);
      } else {
        void bridge.createTab(trimmed);
      }
    },
    [activeTab, bridge, urlDraft]
  );

  if (!bridge) {
    // Capability gating means this surface is only mounted with a live bridge;
    // this is a defensive fallback, never expected to render.
    return <div className="p-4 text-muted-foreground text-xs">Browser pane unavailable.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-pane">
      <div className="flex h-8 shrink-0 items-center gap-1 border-border border-b px-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
          {tabs.map((tab) => (
            <div
              className={`flex h-6 max-w-40 shrink-0 items-center gap-1 rounded px-2 text-xs ${
                tab.active ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              key={tab.tabId}
            >
              <button
                className="min-w-0 truncate"
                data-testid={`browser-tab-${tab.tabId}`}
                onClick={() => bridge.selectTab(tab.tabId)}
                type="button"
              >
                {tab.title || tab.url || 'New Tab'}
              </button>
              <button
                aria-label="Close tab"
                className="shrink-0 opacity-60 hover:opacity-100"
                onClick={() => bridge.closeTab(tab.tabId)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button
          aria-label="New tab"
          data-testid="browser-new-tab"
          onClick={() => bridge.createTab()}
          size="icon"
          variant="ghost"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-2">
        <Button
          aria-label="Back"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTab && bridge.navigate(activeTab.tabId, 'back')}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          aria-label="Forward"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTab && bridge.navigate(activeTab.tabId, 'forward')}
          size="icon"
          variant="ghost"
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          aria-label="Reload"
          disabled={!activeTab}
          onClick={() => activeTab && bridge.navigate(activeTab.tabId, activeTab.url)}
          size="icon"
          variant="ghost"
        >
          <RotateCw className="size-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleNavigate}>
          <Input
            aria-label="Address"
            className="h-6 text-xs"
            data-testid="browser-url-input"
            onBlur={() => setEditing(false)}
            onChange={(event) => {
              setEditing(true);
              setUrlDraft(event.target.value);
            }}
            placeholder="Search or enter address"
            value={urlDraft}
          />
        </form>
      </div>
      {/* Native WebContentsView overlays exactly this reserved region. */}
      <div className="min-h-0 flex-1" data-testid="browser-pane-viewport" ref={paneRef} />
    </div>
  );
}
