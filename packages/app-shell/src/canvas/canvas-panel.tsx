import { usePGliteDatabase } from '@brainstrike/db/react';
import { Button, CanvasFrame, useResolvedTheme } from '@brainstrike/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import {
  type CanvasPanelSummary,
  type CanvasPanelVersion,
  getCanvasVersion,
  listThreadCanvasSummaries,
} from './canvas-read-repository';

export interface CanvasPanelProps {
  /**
   * URL of the trusted Canvas shell — `brainstrike-canvas://shell/` on
   * desktop, `/canvas-frame.html` on web. Provided by the app, mirroring how
   * each app owns its platform-specific wiring in `root-layout-content`.
   */
  readonly shellSrc: string;
}

/** 'latest' auto-follows new versions; a number pins the stepper. */
type VersionSelection = number | 'latest';

/**
 * Canvas surface (BST-1173): read-only viewer over the thread's canvas
 * documents, rendered through the sandboxed CanvasFrame with a version
 * stepper. All writes flow through the `brainstrike.manageCanvas` tool; this
 * panel re-queries when `canvasRefreshNonce` bumps (a manageCanvas completion
 * on the edit-activity stream) or the active thread changes.
 *
 * SELECTION MODEL (React Doctor `no-adjust-state-on-prop-change`): the
 * selected canvas/version are stored as USER INTENT (`selectedCanvasId`,
 * per-canvas `VersionSelection`) and reconciled against fresh query results
 * by DERIVATION — a vanished canvas falls back to the newest one, an
 * out-of-range pinned version clamps to the latest — never by effects
 * re-writing state after data changes.
 */
export function CanvasPanel({ shellSrc }: CanvasPanelProps): ReactElement {
  const database = usePGliteDatabase();
  const theme = useResolvedTheme();
  const threadId = useChangesNavigationStore((state) => state.activeThreadIdentity?.threadId);
  const refreshNonce = useChangesNavigationStore((state) => state.canvasRefreshNonce);

  const [summaries, setSummaries] = useState<readonly CanvasPanelSummary[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [versionSelections, setVersionSelections] = useState<
    Readonly<Record<string, VersionSelection>>
  >({});
  const [loadedVersion, setLoadedVersion] = useState<CanvasPanelVersion | null>(null);
  const [shellFailure, setShellFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!(database && threadId)) {
      setSummaries([]);
      return;
    }
    let cancelled = false;
    void listThreadCanvasSummaries(database, threadId).then((rows) => {
      if (!cancelled) {
        setSummaries(rows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [database, refreshNonce, threadId]);

  const activeSummary = useMemo(() => {
    if (summaries.length === 0) {
      return null;
    }
    return summaries.find((summary) => summary.canvasId === selectedCanvasId) ?? summaries[0];
  }, [selectedCanvasId, summaries]);

  const selection: VersionSelection = activeSummary
    ? (versionSelections[activeSummary.canvasId] ?? 'latest')
    : 'latest';
  const shownVersion = activeSummary
    ? selection === 'latest'
      ? activeSummary.latestVersion
      : Math.min(selection, activeSummary.latestVersion)
    : null;

  useEffect(() => {
    if (!(database && activeSummary && shownVersion)) {
      setLoadedVersion(null);
      return;
    }
    let cancelled = false;
    void getCanvasVersion(database, activeSummary.canvasId, shownVersion).then((row) => {
      if (!cancelled) {
        setLoadedVersion(row);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeSummary, database, shownVersion]);

  if (!threadId) {
    return (
      <CanvasPanelEmptyState message="Canvas documents the assistant creates in a thread appear here." />
    );
  }
  if (!activeSummary) {
    return (
      <CanvasPanelEmptyState message="No canvases in this thread yet — ask the assistant to render one." />
    );
  }

  const stepTo = (selectionForCanvas: VersionSelection) => {
    setVersionSelections((previous) => ({
      ...previous,
      [activeSummary.canvasId]: selectionForCanvas,
    }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="canvas-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-border border-b px-2">
        {summaries.length > 1 ? (
          <select
            aria-label="Canvas document"
            className="h-6 min-w-0 flex-1 truncate rounded border border-border bg-transparent px-1 text-xs"
            data-testid="canvas-picker"
            onChange={(event) => setSelectedCanvasId(event.target.value)}
            value={activeSummary.canvasId}
          >
            {summaries.map((summary) => (
              <option key={summary.canvasId} value={summary.canvasId}>
                {summary.title}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs" title={activeSummary.title}>
            {activeSummary.title}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Previous version"
            data-testid="canvas-version-previous"
            disabled={!shownVersion || shownVersion <= 1}
            onClick={() => shownVersion && stepTo(Math.max(1, shownVersion - 1))}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span
            className="text-muted-foreground text-xs tabular-nums"
            data-testid="canvas-version-label"
          >
            v{shownVersion} / {activeSummary.latestVersion}
          </span>
          <Button
            aria-label="Next version"
            data-testid="canvas-version-next"
            disabled={!shownVersion || shownVersion >= activeSummary.latestVersion}
            onClick={() =>
              shownVersion &&
              stepTo(shownVersion + 1 >= activeSummary.latestVersion ? 'latest' : shownVersion + 1)
            }
            size="icon"
            variant="ghost"
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {loadedVersion ? (
          <CanvasFrame
            html={loadedVersion.html}
            onShellTimeout={({ shellSrc: failedSrc }) =>
              setShellFailure(`Canvas shell failed to load (${failedSrc}).`)
            }
            shellSrc={shellSrc}
            theme={theme}
          />
        ) : null}
      </div>
      {shellFailure ? (
        <p className="shrink-0 border-border border-t px-2 py-1 text-destructive text-xs">
          {shellFailure}
        </p>
      ) : null}
    </div>
  );
}

function CanvasPanelEmptyState({ message }: { readonly message: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p className="max-w-64 text-center text-muted-foreground text-xs">{message}</p>
    </div>
  );
}
