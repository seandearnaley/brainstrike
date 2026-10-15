/**
 * The Context workspace tab (ADR-0021, BST-2017): what the active thread's
 * model received, per file and per index chunk, as of any turn on the
 * displayed branch. Everything shown is folded from committed rows by
 * assistant-ui's `ThreadContextFold`; chunk bounds come from the native index.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import {
  type ContextRun,
  fileWindowTokens,
  type ThreadContextAtTurn,
  threadContextAt,
} from '@brainstrike/assistant-ui/thread-context-fold';
import {
  type ContextRingFigure,
  type ThreadContextRecord,
  useThreadContextStore,
} from '@brainstrike/assistant-ui/thread-context-store';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import {
  THREAD_CONTEXT_APP_ID,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { IndexChunkBoundsCapability } from '@brainstrike/indexing-contract/indexer-client';
import { formatTokenCount } from '@brainstrike/tokenization';
import { isAgentColor } from '@brainstrike/types/agent-color';
import {
  Button,
  CopyTextButton,
  cn,
  EmptyState,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import { Download } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { getDelegatedColorPresentation } from '../agent-color-presentation';
import type { AssistantThreadContextSnapshot } from '../assistant-thread-host-context';
import { openHostChildTab } from '../open-host-child-tab';
import { useOptionalRootIdentity } from '../roots/root-identity-context';
import { ChunkStrip } from './chunk-strip';
import { contextBundleMarkdown } from './context-bundle';
import { ContextLens } from './context-lens';
import { KIND_COLOR_CLASS, KIND_LABEL, KIND_ORDER } from './context-map-kinds';
import {
  type ChunkCell,
  type ContextFileRow,
  type ContextMapMode,
  chunkCells,
  contextFileRows,
  contextMapTotals,
  lineBands,
} from './context-map-model';
import { TurnScrubber } from './turn-scrubber';
import { type ContextLane, useContextLanes } from './use-context-lanes';
import { type FileChunksState, useFileChunks } from './use-file-chunks';
import { useRowFreshness } from './use-row-freshness';

export interface ThreadContextPageProps {
  /** The native index's chunk bounds; null draws every file by line bands. */
  readonly chunkBounds: IndexChunkBoundsCapability | null;
}

function tokens(value: number | null): string {
  return value === null ? 'not recorded' : `~${formatTokenCount(value)}`;
}

function cellsFor(
  row: ContextFileRow,
  chunks: FileChunksState | undefined,
  mode: ContextMapMode
): { readonly cells: ChunkCell[]; readonly note?: string } {
  if (chunks?.kind === 'indexed') {
    return { cells: chunkCells(chunks.chunks, row.spans, mode) };
  }
  const note =
    chunks === undefined || chunks.kind === 'loading'
      ? undefined
      : chunks.kind === 'failed'
        ? 'chunk bounds unavailable'
        : chunks.kind === 'not-indexed'
          ? 'not indexed yet'
          : 'outside the index';
  return { cells: chunkCells(lineBands(row.maxLine), row.spans, mode), ...(note ? { note } : {}) };
}

function addedTokensPerTurn(runs: readonly ContextRun[], view: ThreadContextAtTurn): number[] {
  const added = runs.map(() => 0);
  for (const at of view.calls) {
    if (at.call.spans.length > 0 && at.deliveredTokens !== null) {
      added[at.turn - 1] = (added[at.turn - 1] ?? 0) + at.deliveredTokens;
    }
  }
  return added;
}

/** The host compacts once the prompt reaches this share of the input limit (agent-host). */
const COMPACTION_TICK_RATIO = 0.9;

function percentOf(value: number, total: number): string {
  return `${Math.min(100, (value / Math.max(total, 1)) * 100)}%`;
}

/** The composer ring's total against its budget, the files' share, and the compaction tick. */
function ContextRingBar({
  filesTokens,
  ring,
}: {
  readonly filesTokens: number | null;
  readonly ring: ContextRingFigure;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1" data-testid="context-map-ring">
      <div className="flex justify-between gap-3 text-xs">
        <span className="text-muted-foreground">
          Context in use{ring.isEstimated ? ' (estimated)' : ''}
        </span>
        <span className="tabular-nums" data-testid="context-map-ring-total">
          {formatTokenCount(ring.usedTokens).replace(/ tokens$/u, '')} /{' '}
          {formatTokenCount(ring.budgetTokens)}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a stacked bar with a compaction tick; <meter> draws one value. */}
      <div
        aria-label="Context in use"
        aria-valuemax={ring.budgetTokens}
        aria-valuemin={0}
        aria-valuenow={Math.min(ring.usedTokens, ring.budgetTokens)}
        className="relative h-1.5 rounded-full bg-muted"
        role="meter"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-foreground/30"
          style={{ width: percentOf(ring.usedTokens, ring.budgetTokens) }}
        />
        {filesTokens !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-blue-600 dark:bg-blue-400"
            style={{ width: percentOf(Math.min(filesTokens, ring.usedTokens), ring.budgetTokens) }}
            title="Workspace files in the window"
          />
        )}
        <div
          className="absolute -inset-y-0.5 w-px bg-foreground"
          style={{ left: `${COMPACTION_TICK_RATIO * 100}%` }}
          title="The thread compacts near 90% of its input limit"
        />
      </div>
    </div>
  );
}

type DownloadPhase =
  | { readonly kind: 'idle' | 'saved' }
  | { readonly kind: 'error'; readonly message: string };

/** Saves the in-window bundle as Markdown through the shared download path. */
function BundleDownloadButton({ build }: { readonly build: () => string }): ReactElement {
  const [phase, setPhase] = useState<DownloadPhase>({ kind: 'idle' });
  const download = async (): Promise<void> => {
    try {
      await downloadBlobFile({
        blob: new Blob([build()], { type: 'text/markdown;charset=utf-8' }),
        filename: formatTimestampedDownloadFilename({
          extension: 'md',
          generatedAt: new Date(),
          name: 'brainstrike-thread-context',
        }),
      });
      setPhase({ kind: 'saved' });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <span className="flex items-center gap-2">
      <Button
        className="h-7 gap-1 text-xs"
        data-testid="context-map-download-bundle"
        onClick={() => void download()}
        size="sm"
        variant="ghost"
      >
        <Download aria-hidden="true" className="size-3" />
        Download bundle
      </Button>
      <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
        {phase.kind === 'error' ? `Download failed: ${phase.message}` : null}
        {phase.kind === 'saved' ? 'Bundle saved' : null}
      </span>
    </span>
  );
}

function Legend(): ReactElement {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
      {KIND_ORDER.map((kind) => (
        <li className="flex items-center gap-1.5" key={kind}>
          <span
            aria-hidden="true"
            className={cn('h-3 w-3 rounded-[2px] bg-current', KIND_COLOR_CLASS[kind])}
          />
          {KIND_LABEL[kind]}
        </li>
      ))}
      <li>Hatched: delivered, no longer in the window</li>
      <li>Fill height: share of the chunk delivered</li>
    </ul>
  );
}

const NO_RUNS: readonly string[] = [];
const THIS_THREAD = 'this-thread';

const STATUS_LABEL = { idle: null, 'needs-input': 'needs input', working: 'working' } as const;

/** A lane's figure on its chip: the in-window file tokens at its latest turn. */
function laneFigure(lane: ContextLane): string {
  if (lane.state.record) {
    const { branchRunIds, snapshot } = lane.state.record;
    return tokens(fileWindowTokens(threadContextAt(snapshot, branchRunIds)));
  }
  return lane.state.error === undefined ? 'reading…' : 'unavailable';
}

function LaneMark({ color }: { readonly color: string }): ReactElement {
  if (!isAgentColor(color)) {
    return <span aria-hidden="true" className="size-2 rounded-full bg-muted-foreground" />;
  }
  const presentation = getDelegatedColorPresentation(color);
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 rounded-full', presentation.markClassName)}
      style={presentation.style}
    />
  );
}

/** The thread and each subagent it started by the shown turn, one chip each. */
function LaneChips({
  lanes,
  listError,
  onSelect,
  selected,
}: {
  readonly lanes: readonly ContextLane[];
  readonly listError: string | undefined;
  readonly onSelect: (lane: string | null) => void;
  readonly selected: string | null;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Tabs
        onValueChange={(value) => onSelect(value === THIS_THREAD ? null : value)}
        value={selected ?? THIS_THREAD}
      >
        <TabsList aria-label="Lanes" className="h-auto flex-wrap justify-start" size="sm">
          <TabsTrigger data-testid="context-map-lane" value={THIS_THREAD}>
            This thread
          </TabsTrigger>
          {lanes.map((lane) => {
            const status = STATUS_LABEL[lane.child.status];
            return (
              <TabsTrigger
                className="gap-1.5"
                data-testid="context-map-lane"
                key={lane.child.threadId}
                value={lane.child.threadId}
              >
                <LaneMark color={lane.child.color} />
                <span>{lane.child.callSign}</span>
                {status && <span className="text-muted-foreground">· {status}</span>}
                <span className="text-muted-foreground tabular-nums">· {laneFigure(lane)}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      {listError !== undefined && (
        <p className="text-destructive text-xs" role="alert">
          Subagents could not be listed: {listError}
        </p>
      )}
    </div>
  );
}

interface LaneViewProps {
  readonly chunkBounds: IndexChunkBoundsCapability | null;
  /** The lane chips, shown in the header when the thread has subagents. */
  readonly lanes: ReactElement | undefined;
  readonly mode: ContextMapMode;
  /** Shown above the map: a subagent lane's conversation link, and why it stopped updating. */
  readonly notice: ReactElement | undefined;
  readonly onModeChange: (mode: ContextMapMode) => void;
  readonly onSelectTurn: (turn: number) => void;
  readonly record: ThreadContextRecord;
  readonly ring: ContextRingFigure | undefined;
  /** Whose model: "this thread's", or a subagent's call sign. */
  readonly subject: string;
  readonly turn: number;
}

/** One lane's map: the thread's own, or a subagent's from its own log. */
function LaneView({
  chunkBounds,
  lanes,
  mode,
  notice,
  onModeChange,
  onSelectTurn,
  record,
  ring,
  subject,
  turn,
}: LaneViewProps): ReactElement {
  const [selectedKey, setSelectedKey] = useState<string>();
  const view = useMemo(
    () => threadContextAt(record.snapshot, record.branchRunIds, turn),
    [record, turn]
  );
  const rows = useMemo(() => contextFileRows(view.calls, mode), [view, mode]);
  const totals = useMemo(() => contextMapTotals(view, rows), [view, rows]);
  // Chunk bounds are read again once the thread starts a turn or edits a file.
  const chunkRevision = useMemo(() => {
    let edits = 0;
    for (const call of record.snapshot.calls.values()) {
      if (call.spans.some((span) => span.kind === 'edit')) {
        edits += 1;
      }
    }
    return `${record.branchRunIds.length}:${edits}`;
  }, [record]);
  const chunks = useFileChunks(chunkBounds, rows, chunkRevision);
  // The scrubber always describes the whole branch, whichever turn is shown.
  const scrubber = useMemo(() => {
    const runs = record.branchRunIds.flatMap((id) => {
      const run = record.snapshot.runs.get(id);
      return run ? [run] : [];
    });
    const latest = threadContextAt(record.snapshot, record.branchRunIds);
    return { addedTokens: addedTokensPerTurn(runs, latest), runs };
  }, [record]);
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0];
  // Checked lazily for the file in the lens; a file never shown there is not flagged.
  const freshness = useRowFreshness(selected);
  // Read results name their root by id; the explorer owns the folder's display name.
  const identity = useOptionalRootIdentity();
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const folderLabel = (row: ContextFileRow): string => {
    const adapterRootId = row.rootId ? identity?.resolveAdapterRootId(row.rootId) : null;
    const displayName = adapterRootId ? rootDescriptors[adapterRootId]?.displayName : undefined;
    return row.rootName ?? displayName ?? 'A folder not open in the explorer';
  };
  const bundle = useCallback(() => contextBundleMarkdown(rows, view.turn), [rows, view]);
  const title = `What ${subject} model received`;

  if (view.branch.length === 0) {
    return (
      <section
        aria-label="Thread context"
        className="flex h-full min-h-0 flex-col"
        data-testid="thread-context-page"
      >
        <header className="flex flex-col gap-3 border-border border-b px-4 py-3">
          <h2 className="font-semibold text-sm" data-testid="context-map-title">
            {title}
          </h2>
          {lanes}
          {notice}
        </header>
        <EmptyState
          className="min-h-0 flex-1"
          description="Once it runs, the files its model reads, searches and edits show here."
          title="Nothing delivered yet"
        />
      </section>
    );
  }
  const windowUnknown = view.branch[view.turn - 1]?.measured === false;
  const editedWithoutRead = rows.filter((row) => row.editedWithoutRead);
  const changedSinceRead = freshness?.changed && selected ? selected.path : undefined;

  return (
    <section
      aria-label="Thread context"
      className="@container/context-map flex h-full min-h-0 flex-col"
      data-testid="thread-context-page"
    >
      <header className="flex flex-col gap-3 border-border border-b px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="font-semibold text-sm" data-testid="context-map-title">
              {title}
            </h2>
            <p className="text-muted-foreground text-xs">
              As of turn {view.turn} of {view.branch.length}
              {view.turn === view.branch.length ? ' (latest)' : ''}
            </p>
          </div>
          <Tabs
            onValueChange={(value) => onModeChange(value === 'all' ? 'all' : 'window')}
            value={mode}
          >
            <TabsList aria-label="Show" size="sm">
              <TabsTrigger data-testid="context-map-mode-window" value="window">
                In window now
              </TabsTrigger>
              <TabsTrigger data-testid="context-map-mode-all" value="all">
                Everything seen
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {lanes}
        {notice}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Workspace files in the window</dt>
            <dd className="font-medium tabular-nums" data-testid="context-map-window-tokens">
              {tokens(totals.windowTokens)}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Delivered this thread</dt>
            <dd className="tabular-nums">{tokens(totals.deliveredTokens)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Delivered more than once</dt>
            <dd className="tabular-nums">~{formatTokenCount(totals.rereadTokens)}</dd>
          </div>
        </dl>
        {ring && <ContextRingBar filesTokens={totals.windowTokens} ring={ring} />}
        <TurnScrubber
          addedTokens={scrubber.addedTokens}
          onSelect={onSelectTurn}
          runs={scrubber.runs}
          selected={view.turn}
        />
        <ul className="flex flex-wrap gap-1.5 text-xs" data-testid="context-map-signals">
          {windowUnknown && (
            <li className="rounded-full border border-border px-2 py-0.5">
              This turn's requests did not record their window
            </li>
          )}
          {changedSinceRead && (
            <li
              className="rounded-full border border-foreground px-2 py-0.5"
              data-testid="context-map-changed-since-read"
            >
              Changed since read: {changedSinceRead}
            </li>
          )}
          {editedWithoutRead.length > 0 && (
            <li className="rounded-full border border-foreground border-dashed px-2 py-0.5">
              Edited without reading: {editedWithoutRead.map((row) => row.path).join(', ')}
            </li>
          )}
          {totals.unmappedCalls > 0 && (
            <li className="rounded-full border border-border px-2 py-0.5">
              {totals.unmappedCalls} result(s) could not be mapped to lines
            </li>
          )}
          {totals.otherCalls > 0 && (
            <li className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
              {totals.otherCalls} other call(s) delivered no file lines
            </li>
          )}
        </ul>
      </header>
      <div className="grid min-h-0 flex-1 @[56rem]/context-map:grid-cols-[minmax(0,1fr)_22rem] grid-cols-1">
        <ul aria-label="Files the model received" className="min-h-0 overflow-y-auto p-2">
          {rows.map((row) => {
            const { cells, note } = cellsFor(row, chunks.get(row.key), mode);
            const isSelected = row.key === selected?.key;
            const changedNow = isSelected && freshness?.changed === true;
            return (
              <li key={row.key}>
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    // Narrow: name and tokens, then the strip on its own line.
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded px-2 py-1.5 text-left',
                    '@[40rem]/context-map:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_6rem]',
                    'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-muted',
                    mode === 'window' && row.gone && 'opacity-60'
                  )}
                  data-testid="context-map-file"
                  onClick={() => setSelectedKey(row.key)}
                  type="button"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-xs">{row.path.split('/').at(-1)}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {row.path}
                    </span>
                    {(note || row.editedWithoutRead || changedNow) && (
                      <span className="text-[11px] text-muted-foreground">
                        {[
                          changedNow ? 'changed since read' : null,
                          row.editedWithoutRead ? 'edited without reading' : null,
                          note,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="@[40rem]/context-map:order-none order-last @[40rem]/context-map:col-span-1 col-span-2">
                    <ChunkStrip cells={cells} label={`${row.path}: delivered chunks`} />
                  </span>
                  <span className="text-right text-xs tabular-nums">
                    {tokens(mode === 'window' ? row.windowTokens : row.deliveredTokens)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <aside className="min-h-0 overflow-y-auto border-border border-t @[56rem]/context-map:border-t-0 @[56rem]/context-map:border-l p-4">
          {selected && (
            <ContextLens
              cells={cellsFor(selected, chunks.get(selected.key), mode).cells}
              folderLabel={folderLabel(selected)}
              freshness={freshness}
              row={selected}
            />
          )}
        </aside>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-border border-t px-4 py-2">
        <Legend />
        <span className="flex items-center gap-1">
          <CopyTextButton
            ariaLabel="Copy the in-window file context as Markdown"
            label="Copy context bundle"
            text={bundle}
          />
          <BundleDownloadButton build={bundle} />
        </span>
      </footer>
    </section>
  );
}

/** A subagent's lane before its log has been read, or when it could not be. */
function LaneStatus({
  callSign,
  lanes,
  onRetry,
  state,
}: {
  readonly callSign: string;
  readonly lanes: ReactElement | undefined;
  readonly onRetry: () => void;
  readonly state: AssistantThreadContextSnapshot;
}): ReactElement {
  return (
    <section
      aria-label="Thread context"
      className="flex h-full min-h-0 flex-col"
      data-testid="thread-context-page"
    >
      <header className="flex flex-col gap-3 border-border border-b px-4 py-3">
        <h2 className="font-semibold text-sm" data-testid="context-map-title">
          What {callSign}'s model received
        </h2>
        {lanes}
      </header>
      {state.error === undefined ? (
        <p className="p-4 text-muted-foreground text-xs" role="status">
          Reading {callSign}'s log…
        </p>
      ) : (
        <LaneError callSign={callSign} message={state.error} onRetry={onRetry} />
      )}
    </section>
  );
}

function LaneError({
  callSign,
  message,
  onRetry,
}: {
  readonly callSign: string;
  readonly message: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-destructive text-xs"
      data-testid="context-map-lane-error"
      role="alert"
    >
      <span>
        {callSign}'s log could not be read: {message}
      </span>
      <Button className="h-6 text-xs" onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </div>
  );
}

export function ThreadContextPage({ chunkBounds }: ThreadContextPageProps): ReactElement {
  const threadId = useActiveAssistantThreadId();
  const record = useThreadContextStore((state) =>
    threadId ? state.byThread[threadId] : undefined
  );
  const ring = useThreadContextStore((state) =>
    threadId ? state.ringByThread[threadId] : undefined
  );
  const [mode, setMode] = useState<ContextMapMode>('window');
  // A chosen turn and lane belong to their thread; a new thread starts on its
  // own lane at its latest turn, and so does each subagent's lane.
  const [pinned, setPinned] = useState<{
    readonly threadId: string;
    readonly turns: Readonly<Record<string, number>>;
  }>();
  const [chosenLane, setChosenLane] = useState<{
    readonly lane: string;
    readonly threadId: string;
  }>();
  // A hidden workspace tab stays mounted, so lanes read only while this one is shown.
  const shown = useWorkspaceTabSelectionStore(
    (state) => state.selection.kind === 'app' && state.selection.appId === THREAD_CONTEXT_APP_ID
  );
  const { lanes, listError, retry } = useContextLanes(
    shown ? threadId : null,
    record?.branchRunIds ?? NO_RUNS
  );

  if (!threadId) {
    return (
      <EmptyState
        className="h-full"
        description="Open a thread to see the files its model received."
        title="No active thread"
      />
    );
  }
  if (!record || record.branchRunIds.length === 0) {
    return (
      <EmptyState
        className="h-full"
        description="Once this thread runs, the files its model reads, searches and edits show here."
        title="Nothing delivered yet"
      />
    );
  }
  const turns = pinned?.threadId === threadId ? pinned.turns : {};
  const turnOf = (laneId: string, latest: number): number =>
    Math.min(turns[laneId] ?? latest, latest);
  const pinTurn = (laneId: string) => (turn: number) =>
    setPinned({ threadId, turns: { ...turns, [laneId]: turn } });
  // A subagent's lane opens from the turn whose run started it.
  const parentTurn = turnOf(threadId, record.branchRunIds.length);
  const present = lanes.filter((lane) => lane.startedAtTurn <= parentTurn);
  const lane =
    chosenLane?.threadId === threadId
      ? present.find((candidate) => candidate.child.threadId === chosenLane.lane)
      : undefined;
  const chips =
    present.length > 0 || listError !== undefined ? (
      <LaneChips
        lanes={present}
        listError={listError}
        onSelect={(next) => setChosenLane(next === null ? undefined : { lane: next, threadId })}
        selected={lane?.child.threadId ?? null}
      />
    ) : undefined;

  if (lane) {
    const { child, state } = lane;
    if (!state.record) {
      return (
        <LaneStatus
          callSign={child.callSign}
          lanes={chips}
          onRetry={() => retry(child.threadId)}
          state={state}
        />
      );
    }
    return (
      <LaneView
        chunkBounds={chunkBounds}
        key={child.threadId}
        lanes={chips}
        mode={mode}
        notice={
          <span className="flex flex-wrap items-center gap-2">
            <Button
              className="h-6 text-xs"
              data-testid="context-map-open-lane-conversation"
              onClick={() => openHostChildTab(child)}
              size="sm"
              variant="outline"
            >
              Open {child.callSign}'s conversation
            </Button>
            {state.error !== undefined && (
              <LaneError
                callSign={child.callSign}
                message={state.error}
                onRetry={() => retry(child.threadId)}
              />
            )}
          </span>
        }
        onModeChange={setMode}
        onSelectTurn={pinTurn(child.threadId)}
        record={state.record}
        ring={undefined}
        subject={`${child.callSign}'s`}
        turn={turnOf(child.threadId, state.record.branchRunIds.length)}
      />
    );
  }
  return (
    <LaneView
      chunkBounds={chunkBounds}
      key={threadId}
      lanes={chips}
      mode={mode}
      notice={undefined}
      onModeChange={setMode}
      onSelectTurn={pinTurn(threadId)}
      record={record}
      ring={ring}
      subject="this thread's"
      turn={parentTurn}
    />
  );
}
