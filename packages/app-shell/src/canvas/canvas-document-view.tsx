import { Button, CanvasFrame, saveDownload, useResolvedTheme } from '@brainstrike/ui';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type { CanvasWorkspaceTab } from './canvas-workspace-tab';
import { canvasHtmlFile } from './download-canvas-html';
import type { ThreadCanvasRead } from './use-thread-canvas-reads';

/** 'latest' follows new versions as runs commit them; a number pins the stepper. */
type VersionSelection = number | 'latest';

export interface CanvasDocumentViewProps {
  /** The canvas's thread, as `useThreadCanvasReads` last read it; absent until the first read. */
  readonly read: ThreadCanvasRead | undefined;
  /**
   * URL of the trusted Canvas shell (`brainstrike-canvas://shell/` on
   * desktop), provided by the app that owns the platform wiring.
   */
  readonly shellSrc: string;
  readonly tab: CanvasWorkspaceTab;
}

function saveVersion(version: {
  readonly html: string;
  readonly title: string;
  readonly version: number;
}): void {
  void saveDownload({ build: () => canvasHtmlFile(version), what: 'canvas' });
}

function CanvasNotice({
  message,
  tone = 'muted',
}: {
  readonly message: string;
  readonly tone?: 'error' | 'muted';
}): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p
        className={
          tone === 'error'
            ? 'text-destructive max-w-72 text-center text-xs'
            : 'text-muted-foreground max-w-64 text-center text-xs'
        }
        data-testid={tone === 'error' ? 'canvas-error' : undefined}
        role={tone === 'error' ? 'alert' : 'status'}
      >
        {message}
      </p>
    </div>
  );
}

/**
 * One canvas in its own workspace tab (BST-1173): a read-only view of its
 * committed versions in the sandboxed CanvasFrame, with a version stepper and
 * an HTML download. All writes flow through the `brainstrike.manageCanvas`
 * tool. Which version shows is this tab's own intent, reconciled with each
 * fresh read by derivation: a pinned version past the latest clamps to it.
 */
export function CanvasDocumentView({ read, shellSrc, tab }: CanvasDocumentViewProps): ReactElement {
  const theme = useResolvedTheme();
  const [selection, setSelection] = useState<VersionSelection>('latest');
  const [shellFailure, setShellFailure] = useState<string | null>(null);

  if (read === undefined || read.status === 'loading') {
    return <CanvasNotice message="Loading canvas…" />;
  }
  if (read.status === 'error') {
    return <CanvasNotice message={read.error} tone="error" />;
  }
  const versions = read.canvases.get(tab.canvasId);
  const latest = versions?.at(-1);
  if (!(versions && latest)) {
    return (
      <CanvasNotice message="This canvas is no longer in its thread. A rewind or an edited message may have removed it." />
    );
  }
  const shownVersion =
    selection === 'latest' ? latest.version : Math.min(selection, latest.version);
  const shown = versions.find((candidate) => candidate.version === shownVersion);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="canvas-document">
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate text-xs"
          data-testid="canvas-title"
          title={latest.title}
        >
          {latest.title}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Previous version"
            data-testid="canvas-version-previous"
            disabled={shownVersion <= 1}
            onClick={() => setSelection(Math.max(1, shownVersion - 1))}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span
            className="text-muted-foreground text-xs tabular-nums"
            data-testid="canvas-version-label"
          >
            v{shownVersion} / {latest.version}
          </span>
          <Button
            aria-label="Next version"
            data-testid="canvas-version-next"
            disabled={shownVersion >= latest.version}
            onClick={() =>
              setSelection(shownVersion + 1 >= latest.version ? 'latest' : shownVersion + 1)
            }
            size="icon-xs"
            variant="ghost"
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            aria-label="Download HTML"
            data-testid="canvas-download"
            disabled={!shown}
            onClick={() => {
              if (shown) {
                saveVersion(shown);
              }
            }}
            size="icon-xs"
            title="Download HTML"
            variant="ghost"
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {shown ? (
          <CanvasFrame
            html={shown.html}
            onShellReady={() => setShellFailure(null)}
            onShellTimeout={({ shellSrc: failedSrc }) =>
              setShellFailure(`Canvas shell failed to load (${failedSrc}).`)
            }
            shellSrc={shellSrc}
            theme={theme}
          />
        ) : (
          // A version the read advertised but cannot find is a real inconsistency.
          <CanvasNotice message={`Canvas version v${shownVersion} not found.`} tone="error" />
        )}
      </div>
      {shellFailure ? (
        <p
          className="border-border text-destructive shrink-0 border-t px-2 py-1 text-xs"
          data-testid="canvas-shell-failure"
        >
          {shellFailure}
        </p>
      ) : null}
    </div>
  );
}
