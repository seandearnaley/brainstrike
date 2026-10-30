import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useWorkspaceTabs } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createLogger } from '@brainstrike/logging';
import { Button, Input, useToast } from '@brainstrike/ui';
import { ArrowLeft, ArrowRight, Bot, RotateCw } from 'lucide-react';
import {
  type FormEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import type { BrowserBridge } from './browser-bridge';
import { type BrowserPageTab, browserPageTabId } from './browser-page-tab';
import { useBrowserTabsStore } from './browser-tabs-store';

const logger = createLogger('BrowserPage');

/**
 * Keep main's native view over `viewport` while `shown`. A `WebContentsView`
 * paints above all DOM, so only the selected page tab reports, and it hides
 * the view again when it stops being shown or unmounts. React runs every
 * effect cleanup of a commit before its setups, so switching from one page
 * tab to another hides the old page before the new one is revealed.
 */
function usePageOnScreen(
  bridge: BrowserBridge,
  tabId: string,
  shown: boolean,
  viewport: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const pane = viewport.current;
    if (!(shown && pane)) {
      return;
    }
    let frame = 0;
    const report = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = pane.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          void bridge.setOccluded(true);
          return;
        }
        // Choose and position BEFORE revealing, so the view only ever appears
        // at the freshly measured rect. The rect is in CSS pixels: main scales
        // it by this page's zoom and rounds it, and a zoom change resizes the
        // window, which measures again.
        void bridge.showTab(tabId).catch((error: unknown) => {
          logger.error('Showing the browser page failed', { error, tabId });
        });
        void bridge.setBounds({ height: rect.height, width: rect.width, x: rect.x, y: rect.y });
        void bridge.setOccluded(false);
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
      void bridge.setOccluded(true);
    };
  }, [bridge, shown, tabId, viewport]);
}

/**
 * One browser page in its own workspace tab (BST-1271): back, forward,
 * reload and the address bar as DOM, over an empty region main's native
 * `WebContentsView` overlays.
 *
 * The page is on screen only while its tab is selected on the Explorer route
 * and nothing drops over it: the ⌘K palette, a workspace strip menu, or a
 * toast (they stack bottom-right, where the workspace pane sits). Other
 * transient overlays — popovers, dialogs, page context menus — are a
 * documented follow-up.
 */
export function BrowserPageView({
  bridge,
  tab,
}: {
  readonly bridge: BrowserBridge;
  readonly tab: BrowserPageTab;
}): ReactElement {
  const page = useBrowserTabsStore((state) =>
    state.tabs.find((candidate) => candidate.tabId === tab.tabId)
  );
  const seeded = useBrowserTabsStore((state) => state.seeded);
  const appId = browserPageTabId(tab);
  const selected = useWorkspaceTabSelectionStore(
    (state) => state.selection.kind === 'app' && state.selection.appId === appId
  );
  const onExplorer = usePanelLayoutStore((state) => state.activeTab === 'explorer');
  const paletteOpen = useCommandPaletteStore((state) => state.isOpen);
  const { isMenuOpen } = useWorkspaceTabs();
  const toastOpen = useToast().toasts.some((toast) => toast.open);
  const viewport = useRef<HTMLDivElement | null>(null);
  usePageOnScreen(
    bridge,
    tab.tabId,
    page !== undefined && selected && onExplorer && !paletteOpen && !isMenuOpen && !toastOpen,
    viewport
  );

  // The address follows the page unless the person is editing it: `null`
  // follows, any string is their edit. Cleared on submit and on blur.
  const [draft, setDraft] = useState<string | null>(null);
  const address = draft ?? page?.url ?? '';
  const run = (action: Promise<unknown>, label: string): void => {
    void action.catch((error: unknown) => {
      logger.error('Browser page action failed', { error, label, tabId: tab.tabId });
    });
  };
  const handleNavigate = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = address.trim();
    setDraft(null);
    if (trimmed) {
      run(bridge.navigate(tab.tabId, trimmed), 'navigate');
    }
  };

  if (!page) {
    return (
      <p className="text-muted-foreground p-4 text-xs" data-testid="browser-page-closed">
        {seeded ? 'This page is closed.' : 'Loading page…'}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-page">
      <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Button
          aria-label="Back"
          disabled={!page.canGoBack}
          onClick={() => run(bridge.goBack(tab.tabId), 'goBack')}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          aria-label="Forward"
          disabled={!page.canGoForward}
          onClick={() => run(bridge.goForward(tab.tabId), 'goForward')}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          aria-label="Reload"
          onClick={() => run(bridge.reload(tab.tabId), 'reload')}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCw className="size-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleNavigate}>
          <Input
            aria-label="Address"
            className="h-6 text-xs"
            data-testid="browser-url-input"
            onBlur={() => setDraft(null)}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search or enter address"
            value={address}
          />
        </form>
        {page.owner === 'agent' ? (
          // The agent's own page browses behind its egress proxy (BST-1238).
          <span
            className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
            data-testid="browser-page-agent"
            title="The agent opened this page. It browses through the agent's network guard."
          >
            <Bot className="size-3.5" />
            Agent
          </span>
        ) : null}
      </div>
      {/* Native WebContentsView overlays exactly this reserved region. */}
      <div className="min-h-0 flex-1" data-testid="browser-page-viewport" ref={viewport} />
    </div>
  );
}
