import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useWorkspaceTabs } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  ErrorNotice,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { ArrowLeft, ArrowRight, Bot, RotateCw } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
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

type PageAction = 'goBack' | 'goForward' | 'navigate' | 'reload';

const FAILURE_LABEL: Readonly<Record<PageAction, string>> = {
  goBack: "Couldn't go back",
  goForward: "Couldn't go forward",
  navigate: "Couldn't open the address",
  reload: "Couldn't reload the page",
};

/**
 * A toolbar button with its name as a tooltip. The tooltip opens upward: the
 * page below is a native view drawn above all DOM, which would cover it.
 */
function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

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
 * timed toast (they stack bottom-right, where the workspace pane sits). A
 * persistent toast stays until someone closes it, so it does not take the
 * page away; it is still drawn under the page. Other transient overlays —
 * popovers, dialogs, page context menus — are a documented follow-up.
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
  const toastOpen = useToast().toasts.some((toast) => toast.open && !toast.persistent);
  const viewport = useRef<HTMLDivElement | null>(null);
  usePageOnScreen(
    bridge,
    tab.tabId,
    page !== undefined && selected && onExplorer && !paletteOpen && !isMenuOpen && !toastOpen,
    viewport
  );

  // The address follows the page until the person types: `null` follows, any
  // string is their edit. It stays when focus leaves (another window, the page's
  // own view), as a browser's does, and clears when they navigate from here or
  // the page goes somewhere else (a link, a redirect, the agent). A new tab's
  // first address replaces nothing it was typed over.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftOver, setDraftOver] = useState(page?.url);
  if (page?.url !== draftOver) {
    setDraftOver(page?.url);
    if (draftOver) {
      setDraft(null);
    }
  }
  const address = draft ?? page?.url ?? '';
  // The last action that failed, shown in the pane with a Retry until the next
  // action starts.
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly retry: () => void;
  } | null>(null);
  const run = (label: PageAction, start: () => Promise<unknown>): void => {
    setDraft(null);
    setFailure(null);
    void start().catch((error: unknown) => {
      logger.error('Browser page action failed', { error, label, tabId: tab.tabId });
      setFailure({
        message: `${FAILURE_LABEL[label]}: ${getErrorMessage(error)}`,
        retry: () => run(label, start),
      });
    });
  };
  const handleNavigate = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = address.trim();
    setDraft(null);
    if (trimmed) {
      run('navigate', () => bridge.navigate(tab.tabId, trimmed));
    }
  };
  // Escape gives up the edit: the address shows the page's own URL again.
  const handleAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && draft !== null) {
      event.preventDefault();
      setDraft(null);
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
      <div className="border-border relative flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <TooltipProvider delayDuration={300}>
          <ToolbarButton
            disabled={!page.canGoBack}
            label="Back"
            onClick={() => run('goBack', () => bridge.goBack(tab.tabId))}
          >
            <ArrowLeft className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            disabled={!page.canGoForward}
            label="Forward"
            onClick={() => run('goForward', () => bridge.goForward(tab.tabId))}
          >
            <ArrowRight className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Reload"
            onClick={() => run('reload', () => bridge.reload(tab.tabId))}
          >
            <RotateCw className="size-3.5" />
          </ToolbarButton>
        </TooltipProvider>
        <form className="min-w-0 flex-1" onSubmit={handleNavigate}>
          <Input
            aria-label="Address"
            className="h-6 text-xs"
            data-testid="browser-url-input"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleAddressKeyDown}
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
        {page.isLoading ? (
          // An indeterminate bar along the toolbar's bottom edge while the
          // page's main frame loads.
          <div
            aria-label="Loading page"
            className="bg-primary/70 absolute inset-x-0 bottom-0 h-0.5 motion-safe:animate-pulse"
            data-testid="browser-page-loading"
            role="progressbar"
          />
        ) : null}
      </div>
      {failure ? (
        <ErrorNotice
          className="m-2 shrink-0"
          data-testid="browser-page-error"
          message={failure.message}
          onRetry={failure.retry}
        />
      ) : null}
      {/* Native WebContentsView overlays exactly this reserved region. */}
      <div className="min-h-0 flex-1" data-testid="browser-page-viewport" ref={viewport} />
    </div>
  );
}
