import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantEditCheckpointRecord,
  createAssistantRunEvent,
} from '@brainstrike/assistant-contract';
import type { ChangedFileEntry, ChangesetView, StructuredFileDiff } from '@brainstrike/types';
import type { DiffReviewFile, DiffReviewProps } from '@brainstrike/ui/diff-view';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChangesReviewContextValue, ChangesReviewProvider } from '../changes-review-context';
import {
  type EditCheckpointContextValue,
  EditCheckpointProvider,
} from '../edit-checkpoint-context';
import { TurnChangesCard } from '../turn-changes-card';

let mockParts: unknown[] = [];
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(selector: (state: { message: { parts: unknown[] } }) => T) =>
    selector({ message: { parts: mockParts } }),
}));

const TOOL_CALL_ID = 'call-1';

function toolCallPart(toolCallId: string) {
  return { toolCallId, type: 'tool-call' };
}

function runFinishedPart(runId: string) {
  return {
    data: createAssistantRunEvent({
      kind: 'run.finished',
      label: 'Run finished',
      runId,
      status: 'completed',
    }),
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  };
}

function makeEntry(
  overrides: Partial<AssistantEditCheckpointRecord> = {}
): AssistantEditCheckpointRecord {
  return {
    afterExisted: true,
    afterHash: 'after',
    beforeExisted: true,
    beforeHash: 'before',
    beforeSize: 10,
    captureStatus: 'ok',
    fromPath: null,
    id: 'ckpt-1',
    occurredAt: '2026-04-22T10:00:00.000Z',
    op: 'write',
    path: '/a.ts',
    resourceId: 'workspace-a',
    revertedAt: null,
    rootId: 'root-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolCallId: TOOL_CALL_ID,
    toolName: 'brainstrike.writeWorkspaceFile',
    ...overrides,
  };
}

// The real diff is @pierre/diffs in a shadow root (browser-tested in
// packages/ui); here each file is its header, and opening it loads it.
vi.mock('@brainstrike/ui/diff-view', () => ({
  DiffReview: ({ defaultCollapsed, files, loadFile }: DiffReviewProps) => (
    <ul data-collapsed={String(defaultCollapsed)} data-testid="diff-review">
      {files.map((file: DiffReviewFile) => (
        <li key={file.id}>
          <button onClick={() => void loadFile(file.id)} type="button">
            {file.path}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

/** Stands in for the browser's IntersectionObserver so a test decides when the card nears view. */
const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
class ControlledIntersectionObserver {
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  disconnect(): void {}
  observe(target: Element): void {
    observers.push({ callback: this.callback, target });
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}
vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);

afterEach(() => {
  observers.length = 0;
});

/** Every card on screen comes near view. */
function scrollNear(): void {
  act(() => {
    for (const { callback, target } of observers.splice(0)) {
      callback(
        [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }
  });
}

function changedFile(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    actions: [],
    additions: 2,
    deletions: 1,
    patch: `diff --git a/${path} b/${path}\n`,
    path,
    pathInRoot: path,
    repositoryRoot: null,
    revision: 'r1',
    rootId: 'root-1',
    status: 'modified',
    worktreePath: null,
    ...overrides,
  };
}

function viewOf(files: readonly ChangedFileEntry[]): ChangesetView {
  return {
    changeset: { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
    files,
    totalAdditions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    totalDeletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}

function binding(
  view: ChangesetView | Error = viewOf([changedFile('src/a.ts'), changedFile('notes.txt')])
) {
  const value = {
    openChangesForRun: vi.fn<ChangesReviewContextValue['openChangesForRun']>(),
    readRunChanges: vi.fn<ChangesReviewContextValue['readRunChanges']>(() =>
      view instanceof Error ? Promise.reject(view) : Promise.resolve(view)
    ),
    readRunFile: vi.fn<ChangesReviewContextValue['readRunFile']>(() =>
      Promise.resolve({} as StructuredFileDiff)
    ),
  };
  return value satisfies ChangesReviewContextValue;
}

function checkpointValue(
  entries: readonly AssistantEditCheckpointRecord[]
): EditCheckpointContextValue {
  return {
    availabilityById: new Map(entries.map((entry) => [entry.id, { restorable: true } as const])),
    entries,
    entriesByToolCallId: new Map(
      entries
        .filter((entry) => entry.toolCallId)
        .map((entry) => [entry.toolCallId as string, entry])
    ),
    revertEntry: vi.fn(),
    revertRefusal: null,
    revertRun: vi.fn().mockResolvedValue({ outcomes: [], runId: 'run-1' }),
  };
}

function renderCard(
  ui: ReactElement,
  options: {
    changesReview?: ChangesReviewContextValue | null;
    checkpoint?: EditCheckpointContextValue | null;
  } = {}
) {
  const { changesReview = null, checkpoint = null } = options;
  return render(
    <ChangesReviewProvider value={changesReview}>
      <EditCheckpointProvider value={checkpoint}>{ui}</EditCheckpointProvider>
    </ChangesReviewProvider>
  );
}

describe('TurnChangesCard', () => {
  it('renders nothing without a Changes binding', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const { container } = renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview: null,
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a run the journal records no edit for', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const changesReview = binding();
    const { container } = renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry({ runId: 'run-2' })]),
    });
    scrollNear();
    expect(container).toBeEmptyDOMElement();
    expect(changesReview.readRunChanges).not.toHaveBeenCalled();
  });

  it('renders nothing without a known thread id', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const { container } = renderCard(<TurnChangesCard threadId={undefined} />, {
      changesReview: binding(),
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the run reaches its terminal run.finished event', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID)];
    const { container } = renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview: binding(),
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the turn only once it comes near view, then lists its files folded with git’s counts', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const changesReview = binding();
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry({ rootId: 'root-7' })]),
    });
    expect(changesReview.readRunChanges).not.toHaveBeenCalled();

    scrollNear();
    const card = await screen.findByRole('region', { name: 'Changes from this turn' });
    expect(changesReview.readRunChanges).toHaveBeenCalledWith({
      rootId: 'root-7',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(card).toHaveTextContent('2 files changed');
    expect(card).toHaveTextContent('4 additions, 2 deletions');
    const review = await screen.findByTestId('diff-review');
    expect(review).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'src/a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
  });

  it('opens a file through the binding, naming the root it was changed in', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const other = changedFile('src/a.ts', { rootId: 'root-2' });
    const changesReview = binding(viewOf([changedFile('src/a.ts'), other]));
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry()]),
    });
    scrollNear();
    const [, second] = await screen.findAllByRole('button', { name: 'src/a.ts' });
    fireEvent.click(second as HTMLElement);
    expect(changesReview.readRunFile).toHaveBeenCalledWith(
      { rootId: 'root-1', runId: 'run-1', threadId: 'thread-1' },
      other
    );
  });

  it('Review opens the turn in Changes', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const changesReview = binding();
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry()]),
    });
    scrollNear();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(changesReview.openChangesForRun).toHaveBeenCalledWith('run-1', 'thread-1');
  });

  it('says one file in the singular', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview: binding(viewOf([changedFile('src/a.ts')])),
      checkpoint: checkpointValue([makeEntry()]),
    });
    scrollNear();
    expect(await screen.findByRole('region', { name: 'Changes from this turn' })).toHaveTextContent(
      '1 file changed'
    );
  });

  // A run whose edits were all reverted, or whose snapshots show no change.
  it('renders nothing when the turn changed no file', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const changesReview = binding(viewOf([]));
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry()]),
    });
    scrollNear();
    await act(async () => {
      await changesReview.readRunChanges.mock.results[0]?.value;
    });
    expect(screen.getByTestId('turn-changes')).toBeEmptyDOMElement();
  });

  it('shows why the changes did not load, and Retry reads them again', async () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const changesReview = binding(new Error('The snapshot service is busy.'));
    renderCard(<TurnChangesCard threadId="thread-1" />, {
      changesReview,
      checkpoint: checkpointValue([makeEntry()]),
    });
    scrollNear();
    expect(await screen.findByRole('alert')).toHaveTextContent('The snapshot service is busy.');

    changesReview.readRunChanges.mockResolvedValueOnce(viewOf([changedFile('src/a.ts')]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Changes from this turn' })).toHaveTextContent(
      '1 file changed'
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(changesReview.readRunChanges).toHaveBeenCalledTimes(2);
  });
});
