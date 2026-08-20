import { decodeFileSelection, encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import {
  ActionContextMenu,
  CodeSurface,
  isMarkdownPath,
  useIdeFileEditor,
  useToast,
} from '@brainstrike/ui';
import { resolveRelativePath } from '@brainstrike/utils';
import { Loader2 } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Group, type Layout, Panel, Separator } from 'react-resizable-panels';
import { BinaryFilePreview } from '../components/binary-file-preview';
import { useMarkdownPreviewCapabilities } from '../contexts/markdown-preview-capabilities';
import { useFileViewerContextMenu } from '../hooks/use-file-viewer-context-menu';
import type { FileTab } from '../hooks/use-tab-manager';
import { type FileViewMode, useEditorViewStateStore } from '../stores/editor-view-state-store';
import {
  DEFAULT_PANE_WIDTH_PCT,
  MAX_PANE_WIDTH_PCT,
  MIN_PANE_WIDTH_PCT,
  useFileTabPaneStore,
} from '../stores/file-tab-pane-store';
import { FileTabBreadcrumbPopover } from './file-tab-breadcrumb-popover';
import { buildFileBreadcrumbSegments } from './file-tab-breadcrumb-segments';
import { FileTabExplorerPane } from './file-tab-explorer-pane';
import { FileTabHeader } from './file-tab-header';
import {
  FileContentErrorScreen,
  FileContentPendingScreen,
  FileNotFoundScreen,
  InaccessibleFileScreen,
  PermissionRequiredScreen,
} from './file-tab-status-screens';
import { MarkdownPreviewErrorBoundary } from './markdown-preview-error-boundary';

const MarkdownSurfaceLazy = lazy(() =>
  import('@brainstrike/ui/markdown-surface').then((m) => ({ default: m.MarkdownSurface }))
);

export interface FileTabBodyProps {
  readonly content: string | undefined;
  readonly contentError?: Error;
  readonly isLoading: boolean;
  readonly isRestoring: boolean;
  readonly onRetryContent: () => void;
  readonly rootPath?: string | null;
  readonly status: TabFileStatus | undefined;
  readonly tab: FileTab;
}

export function FileTabBody({
  tab,
  content,
  contentError,
  isLoading,
  isRestoring,
  onRetryContent,
  rootPath = null,
  status,
}: FileTabBodyProps) {
  const path = useMemo(() => {
    try {
      return decodeFileSelection(tab.compositeKey).path;
    } catch {
      return tab.path;
    }
  }, [tab.compositeKey, tab.path]);

  const isMarkdown = isMarkdownPath(path);

  const getScrollTop = useEditorViewStateStore((s) => s.getScrollTop);
  const setScrollTop = useEditorViewStateStore((s) => s.setScrollTop);
  const getTarget = useEditorViewStateStore((s) => s.getTarget);
  const clearTarget = useEditorViewStateStore((s) => s.clearTarget);
  const storedMode = useEditorViewStateStore((s) => s.modes[tab.compositeKey]);
  const setMode = useEditorViewStateStore((s) => s.setMode);

  const capabilities = useMarkdownPreviewCapabilities();
  const { toast } = useToast();
  const ideEditor = useIdeFileEditor();

  // Per-file explorer pane (BST-1269). Pane state is per-thread durable via
  // the workspace snapshot; the reveal target is LOCAL one-shot UI state —
  // FileTabBody is keyed by compositeKey, so a fresh tab re-evaluates. The
  // pane mounts only while open, and its default reveal is the file itself
  // (Cursor idiom: opening the pane lands on the file's location).
  const paneState = useFileTabPaneStore((s) => s.panes[tab.compositeKey]);
  const togglePane = useFileTabPaneStore((s) => s.togglePane);
  const setPaneWidthPct = useFileTabPaneStore((s) => s.setPaneWidthPct);
  // ABSENT state means OPEN (BST-1318): the pane auto-opens with its file and
  // only an explicit user close (open: false, recorded by togglePane) hides
  // it — that entry persists through the snapshot so the close sticks.
  const isPaneOpen = paneState?.open !== false;
  // The nonce makes every activation a NEW reveal request, so re-clicking the
  // same breadcrumb (or re-opening the pane on the same file) re-reveals.
  const [revealRequest, setRevealRequest] = useState<{ nonce: number; path: string | null }>({
    nonce: 0,
    path,
  });
  const handleTogglePane = useCallback(() => {
    setRevealRequest((previous) => ({ nonce: previous.nonce + 1, path }));
    togglePane(tab.compositeKey);
  }, [path, tab.compositeKey, togglePane]);
  const breadcrumbSegments = useMemo(
    () => buildFileBreadcrumbSegments(path, rootPath),
    [path, rootPath]
  );
  // Breadcrumb popover mini-tree (BST-1319): a segment click opens a picker
  // of that segment's siblings; picking a file opens it in a NEW tab via the
  // same flow tree file-clicks use. The pane is untouched by breadcrumbs.
  const handleBreadcrumbPick = useCallback(
    (filePath: string) => {
      let folderId: string;
      try {
        folderId = decodeFileSelection(tab.compositeKey).folderId;
      } catch {
        toast({ description: filePath, title: 'Could not resolve file', variant: 'destructive' });
        return;
      }
      const openFileInTab = ideEditor.openFileInTab;
      if (!openFileInTab) {
        toast({ description: filePath, title: 'File opening unavailable', variant: 'destructive' });
        return;
      }
      openFileInTab(encodeFileSelection(folderId, filePath));
    },
    [ideEditor.openFileInTab, tab.compositeKey, toast]
  );
  const renderBreadcrumbPopover = useCallback(
    (segment: { label: string; path: string }, close: () => void) => (
      <FileTabBreadcrumbPopover
        compositeKey={tab.compositeKey}
        onPickFile={(filePath) => {
          handleBreadcrumbPick(filePath);
          close();
        }}
        rootPath={rootPath}
        segmentPath={segment.path}
      />
    ),
    [handleBreadcrumbPick, rootPath, tab.compositeKey]
  );
  const handlePaneLayoutChanged = useCallback(
    (layout: Layout, meta: { isUserInteraction: boolean }) => {
      if (!meta.isUserInteraction) {
        return;
      }
      const width = layout['file-tab-pane'];
      if (typeof width === 'number') {
        setPaneWidthPct(tab.compositeKey, width);
      }
    },
    [setPaneWidthPct, tab.compositeKey]
  );

  // A line-targeted open (search match) forces source for THIS open only; the
  // user's persisted preference is untouched. Captured once on mount (FileTabBody
  // is keyed by compositeKey, so a fresh open re-evaluates). It stays state — not
  // a derived value — so it does not flip preview→source once the target is
  // consumed/cleared later in the same view.
  const [forceSource, setForceSource] = useState<boolean>(
    () => isMarkdown && useEditorViewStateStore.getState().getTarget(tab.compositeKey) !== undefined
  );
  const effectiveMode: FileViewMode =
    !isMarkdown || forceSource ? 'source' : (storedMode ?? 'preview');

  const handleModeChange = useCallback(
    (mode: FileViewMode) => {
      setForceSource(false);
      setMode(tab.compositeKey, mode);
    },
    [setMode, tab.compositeKey]
  );

  const handleScrollTopChange = useCallback(
    (scrollTop: number) => {
      setScrollTop(tab.compositeKey, scrollTop);
    },
    [setScrollTop, tab.compositeKey]
  );

  const handlePreviewScrollTopChange = useCallback(
    (scrollTop: number) => {
      setScrollTop(`preview:${tab.compositeKey}`, scrollTop);
    },
    [setScrollTop, tab.compositeKey]
  );

  const {
    controller: contextMenuController,
    handleCodeContextMenuSelection,
    handleMarkdownContextMenuSelection,
    handleViewerContextMenu,
    resetContextMenuTarget,
  } = useFileViewerContextMenu({ rootPath, tab, viewMode: effectiveMode });

  const resolveImage = useCallback(
    async (src: string): Promise<string> => {
      // Remote images are blocked in previews regardless of CSP (which allows
      // localhost in dev and is deployment-dependent on web): untrusted file
      // content must not trigger network requests (file-explorer-ui AGENTS.md
      // resource-loading restriction). Failure surfaces as the visible
      // image-unavailable placeholder.
      if (/^https?:/i.test(src)) {
        throw new Error('Remote images are blocked in previews');
      }
      if (/^data:/i.test(src)) {
        return src;
      }
      if (!capabilities) {
        throw new Error('Image preview unavailable');
      }
      const resolved = src.startsWith('/') ? src : resolveRelativePath(path, src);
      if (!resolved) {
        throw new Error('Path escapes the workspace');
      }
      return capabilities.resolveImageSrc(resolved);
    },
    [capabilities, path]
  );

  const handleOpenLink = useCallback(
    (href: string) => {
      // Protocol-relative URLs (`//host/path`) carry no scheme but are NOT
      // workspace-relative — the relative branch below would resolve them to a nonsense
      // workspace key. Reject them explicitly with the same notice as unsupported schemes.
      if (href.startsWith('//')) {
        toast({ description: href, title: 'Unsupported link type', variant: 'destructive' });
        return;
      }
      if (/^(https?|mailto):/i.test(href)) {
        if (!capabilities) {
          toast({ description: href, title: 'External links unavailable', variant: 'destructive' });
          return;
        }
        void capabilities.openExternalLink(href).then((result) => {
          if (!result.ok) {
            toast({
              description: result.error ?? href,
              title: 'Could not open link',
              variant: 'destructive',
            });
          }
        });
        return;
      }
      // Any other URL scheme (tel:, ftp:, javascript:, …) must not fall into the
      // relative-path branch — it would resolve to a nonsense workspace key or a
      // misleading "outside the workspace" toast. Name the real failure instead.
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        toast({ description: href, title: 'Unsupported link type', variant: 'destructive' });
        return;
      }
      // Workspace-relative link → open in a tab.
      let folderId: string;
      try {
        folderId = decodeFileSelection(tab.compositeKey).folderId;
      } catch {
        toast({ description: href, title: 'Could not resolve link', variant: 'destructive' });
        return;
      }
      const resolved = resolveRelativePath(path, href.split('#')[0] ?? href);
      if (!resolved) {
        toast({
          description: href,
          title: 'Link is outside the workspace',
          variant: 'destructive',
        });
        return;
      }
      const openFileInTab = ideEditor.openFileInTab;
      if (!openFileInTab) {
        toast({ description: href, title: 'File opening unavailable', variant: 'destructive' });
        return;
      }
      openFileInTab(encodeFileSelection(folderId, resolved));
    },
    [capabilities, ideEditor.openFileInTab, path, tab.compositeKey, toast]
  );

  // One-shot consumption: only clear once `content` is actually a string, i.e.
  // once the surface below has genuinely mounted with whatever target
  // (initialLine/initialSelection) this render read (content loads async —
  // clearing on every compositeKey change regardless of content would erase the
  // target before the surface ever mounts to consume it). Without this,
  // switching tabs away and back (or closing and reopening) remounts CodeSurface
  // — keyed on compositeKey — and its mount effect re-reads a stale target,
  // yanking the view back to the match line and discarding the user's scroll
  // position.
  useEffect(() => {
    if (typeof content !== 'string') {
      return;
    }
    clearTarget(tab.compositeKey);
  }, [clearTarget, content, tab.compositeKey]);

  let body: ReactNode;
  // Raw untruncated contents for the header's copy affordance — set ONLY on
  // the normal-text branch below (never for BINARY / inaccessible / loading /
  // error tabs). Copy intentionally uses the FULL `content` even when
  // getDisplayContent truncates the DOM for very large files.
  let copyText: string | null = null;
  if (status?.status === 'needs-permission') {
    body = <PermissionRequiredScreen path={path} status={status} />;
  } else if (status?.status === 'not-found') {
    body = <FileNotFoundScreen path={path} status={status} />;
  } else if (contentError) {
    body = (
      <FileContentErrorScreen contentError={contentError} onRetry={onRetryContent} path={path} />
    );
  } else if (typeof content !== 'string') {
    // Three reasons content may be missing here, none of which is "the file is gone":
    //  1. Restoration is still in flight (status not yet emitted).
    //  2. We just opened the tab and loadFileContent hasn't completed.
    //  3. The active tab effect hasn't fired yet (e.g. fileTree not ready on web).
    // In all cases, "Restoring…" is the honest message — "File not found" was a lie.
    body = (
      <FileContentPendingScreen
        isPending={isLoading || isRestoring || status?.status === 'pending'}
      />
    );
  } else if (content === BINARY_CONTENT_MESSAGE) {
    // The worker stores the BINARY sentinel as the tab's content; render the
    // dedicated screen instead of dumping the sentinel into a code surface.
    body = <BinaryFilePreview rootPath={rootPath} tab={tab} />;
  } else if (content.startsWith(INACCESSIBLE_CONTENT_PREFIX)) {
    // Short-circuit before truncation: the inaccessible branch renders the full `content`
    // verbatim, so running getDisplayContent first would do throwaway work and (for a very
    // verbose error message above MAX_DOM_CHARS) produce an unused truncated string.
    body = <InaccessibleFileScreen content={content} />;
  } else {
    const { text, truncated } = getDisplayContent(content);
    const target = getTarget(tab.compositeKey);
    copyText = content;

    body =
      effectiveMode === 'preview' ? (
        <MarkdownPreviewErrorBoundary onOpenSource={() => handleModeChange('source')}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                <span>Loading preview…</span>
              </div>
            }
          >
            <MarkdownSurfaceLazy
              ariaLabel={`Markdown preview for ${path}`}
              initialScrollTop={getScrollTop(`preview:${tab.compositeKey}`)}
              onContextMenuSelection={handleMarkdownContextMenuSelection}
              onOpenLink={handleOpenLink}
              onScrollTopChange={handlePreviewScrollTopChange}
              resolveImageSrc={resolveImage}
              testId="file-markdown-surface"
              truncated={truncated}
              value={text}
            />
          </Suspense>
        </MarkdownPreviewErrorBoundary>
      ) : (
        <CodeSurface
          ariaLabel={`Source preview for ${path}`}
          initialLine={target?.line}
          initialScrollTop={getScrollTop(tab.compositeKey)}
          initialSelection={target?.selection}
          key={tab.compositeKey}
          onContextMenuSelection={handleCodeContextMenuSelection}
          onScrollTopChange={handleScrollTopChange}
          path={path}
          testId="file-code-surface"
          truncated={truncated}
          value={text}
        />
      );
  }

  const fileName = path.split('/').pop() ?? path;
  const directory = path.slice(0, Math.max(0, path.length - fileName.length - 1));

  return (
    <ActionContextMenu controller={contextMenuController}>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: read-only file viewer exposes a context menu while preserving tabpanel/editor semantics */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: contextmenu is an auxiliary action; keyboard invocation is owned by the focused CodeMirror/preview content */}
      <div
        className="flex h-full flex-col"
        onContextMenu={handleViewerContextMenu}
        onContextMenuCapture={resetContextMenuTarget}
      >
        <FileTabHeader
          breadcrumbs={{
            renderSegmentPopover: renderBreadcrumbPopover,
            segments: breadcrumbSegments,
          }}
          copyText={copyText}
          directory={directory}
          fileName={fileName}
          isPaneOpen={isPaneOpen}
          mode={effectiveMode}
          onModeChange={handleModeChange}
          onTogglePane={handleTogglePane}
          showModeToggle={isMarkdown}
        />
        {isPaneOpen ? (
          <Group
            className="min-h-0 flex-1"
            onLayoutChanged={handlePaneLayoutChanged}
            orientation="horizontal"
          >
            <Panel id="file-tab-content">
              <div className="h-full min-h-0">{body}</div>
            </Panel>
            <Separator className="z-10 w-1 bg-border transition-colors hover:bg-border/80" />
            {/* Docked RIGHT (BST-1318), mirroring the main explorer's side. */}
            <Panel
              className="overflow-hidden border-l bg-background"
              defaultSize={`${paneState?.widthPct ?? DEFAULT_PANE_WIDTH_PCT}%`}
              id="file-tab-pane"
              maxSize={`${MAX_PANE_WIDTH_PCT}%`}
              minSize={`${MIN_PANE_WIDTH_PCT}%`}
            >
              <div className="h-full min-h-0" data-testid="file-tab-explorer-pane">
                <FileTabExplorerPane
                  compositeKey={tab.compositeKey}
                  revealNonce={revealRequest.nonce}
                  revealPath={revealRequest.path}
                />
              </div>
            </Panel>
          </Group>
        ) : (
          <div className="min-h-0 flex-1">{body}</div>
        )}
      </div>
    </ActionContextMenu>
  );
}

export { FileTabBody as FileTabBodyForTesting };

/** Hard cap on how much text we paint into the DOM per panel. Beyond this we truncate visibly. */
const MAX_DOM_CHARS = 200_000;

function getDisplayContent(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_DOM_CHARS) {
    return { text: raw, truncated: false };
  }
  const suffix = '\n\n… truncated for display …';
  // Math.max guards against a future where suffix grows past MAX_DOM_CHARS — slice()
  // would silently flip the index sign and produce surprising output otherwise.
  let end = Math.max(0, MAX_DOM_CHARS - suffix.length);
  // Avoid splitting a UTF-16 surrogate pair (e.g. emoji or supplementary CJK at the
  // cut boundary) which would render as a replacement character.
  const HighSurrogateStart = 0xd8_00;
  const HighSurrogateEnd = 0xdb_ff;
  if (
    end > 0 &&
    end < raw.length &&
    raw.charCodeAt(end - 1) >= HighSurrogateStart &&
    raw.charCodeAt(end - 1) <= HighSurrogateEnd
  ) {
    end -= 1;
  }
  return { text: raw.slice(0, end) + suffix, truncated: true };
}
