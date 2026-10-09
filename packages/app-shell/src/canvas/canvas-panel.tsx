import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { Button, CanvasFrame, useResolvedTheme } from '@brainstrike/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import {
  type CanvasPanelSummary,
  type CanvasPanelVersion,
  readThreadCanvasSummaries,
  readThreadCanvasVersion,
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
 * on the edit-activity stream, or a host thread's committed canvas version) or
 * the active thread changes.
 *
 * SELECTION MODEL (React Doctor `no-adjust-state-on-prop-change`): the
 * selected canvas is `focusedCanvasId` in the Changes navigation store
 * (written by the picker and by `canvas://` chips); the version is per-canvas
 * local intent (`VersionSelection`). Both are reconciled against fresh query
 * results by DERIVATION — a vanished canvas falls back to the newest one, an
 * out-of-range pinned version clamps to the latest — never by effects
 * re-writing state after data changes.
 */
export function CanvasPanel({ shellSrc }: CanvasPanelProps): ReactElement {
  const database = usePGliteDatabase();
  const host = useAssistantThreadHost();
  const theme = useResolvedTheme();
  // BST-1268 unification: the ACTIVE thread comes from the thread store —
  // never from the wrapper-published identity (which was last-mount-wins
  // across simultaneously-mounted open threads).
  const threadId = useActiveAssistantThreadId() ?? undefined;
  const refreshNonce = useChangesNavigationStore((state) => state.canvasRefreshNonce);
  const requestCanvasRefresh = useChangesNavigationStore((state) => state.requestCanvasRefresh);
  // A host-owned thread's canvases change as its runs commit versions; the
  // host signals each one and the panel re-reads, like a manageCanvas completion.
  useEffect(
    () => (threadId ? host?.subscribeCanvases?.(threadId, requestCanvasRefresh) : undefined),
    [host, requestCanvasRefresh, threadId]
  );

  const [summaries, setSummaries] = useState<readonly CanvasPanelSummary[]>([]);
  // One owner for "which canvas" (store): the canvas:// chip and this picker
  // write the same field, and selection stays derivation below.
  const focusedCanvasId = useChangesNavigationStore((state) => state.focusedCanvasId);
  const selectCanvas = useChangesNavigationStore((state) => state.selectCanvas);
  const [versionSelections, setVersionSelections] = useState<
    Readonly<Record<string, VersionSelection>>
  >({});
  const [loadedVersion, setLoadedVersion] = useState<CanvasPanelVersion | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [shellFailure, setShellFailure] = useState<string | null>(null);

  useEffect(() => {
    // Clear synchronously on every re-query trigger: a thread switch must
    // never display the PREVIOUS thread's canvases while the new read is in
    // flight (or forever, if it fails).
    setSummaries([]);
    if (!(database && threadId)) {
      return;
    }
    let cancelled = false;
    readThreadCanvasSummaries(database, host, threadId)
      .then((rows) => {
        if (!cancelled) {
          setQueryError(null);
          setSummaries(rows);
        }
      })
      .catch((error: unknown) => {
        // NO SILENT FALLBACKS: a failed read must never masquerade as the
        // "no canvases yet" empty state.
        if (!cancelled) {
          setQueryError(`Canvas list failed: ${String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, host, refreshNonce, threadId]);

  const activeSummary = useMemo(() => {
    if (summaries.length === 0) {
      return null;
    }
    return summaries.find((summary) => summary.canvasId === focusedCanvasId) ?? summaries[0];
  }, [focusedCanvasId, summaries]);

  const selection: VersionSelection = activeSummary
    ? (versionSelections[activeSummary.canvasId] ?? 'latest')
    : 'latest';
  const shownVersion = activeSummary
    ? selection === 'latest'
      ? activeSummary.latestVersion
      : Math.min(selection, activeSummary.latestVersion)
    : null;

  const activeCanvasId = activeSummary?.canvasId ?? null;
  useEffect(() => {
    // Clear synchronously so a canvas/version switch never shows the previous
    // document under the new header while the read is in flight.
    setLoadedVersion(null);
    if (!(database && threadId && activeCanvasId && shownVersion)) {
      return;
    }
    let cancelled = false;
    readThreadCanvasVersion(database, host, threadId, activeCanvasId, shownVersion)
      .then((row) => {
        if (cancelled) {
          return;
        }
        if (row) {
          setQueryError(null);
          setLoadedVersion(row);
          return;
        }
        // A version the summary advertised but the read cannot find is a real
        // inconsistency (reset race, deleted rows) — surface it.
        setQueryError(`Canvas version v${shownVersion} not found.`);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQueryError(`Canvas read failed: ${String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCanvasId, database, host, shownVersion, threadId]);

  if (!threadId) {
    return (
      <CanvasPanelEmptyState message="Canvas documents the assistant creates in a thread appear here." />
    );
  }
  if (queryError && !activeSummary) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="max-w-72 text-center text-destructive text-xs" data-testid="canvas-error">
          {queryError}
        </p>
      </div>
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
            onChange={(event) => selectCanvas(event.target.value)}
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
            onShellReady={() => setShellFailure(null)}
            onShellTimeout={({ shellSrc: failedSrc }) =>
              setShellFailure(`Canvas shell failed to load (${failedSrc}).`)
            }
            shellSrc={shellSrc}
            theme={theme}
          />
        ) : null}
      </div>
      {queryError ? (
        <p
          className="shrink-0 border-border border-t px-2 py-1 text-destructive text-xs"
          data-testid="canvas-error"
        >
          {queryError}
        </p>
      ) : null}
      {shellFailure ? (
        <p
          className="shrink-0 border-border border-t px-2 py-1 text-destructive text-xs"
          data-testid="canvas-shell-failure"
        >
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
