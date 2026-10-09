import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantEditCheckpointRecord,
  createAssistantRunEvent,
} from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ChangesReviewContextValue, ChangesReviewProvider } from '../changes-review-context';
import { ChangesReviewLink } from '../changes-review-link';
import {
  type EditCheckpointContextValue,
  EditCheckpointProvider,
} from '../edit-checkpoint-context';

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

function mockOpenChangesForRun() {
  return vi.fn<(runId: string, threadId: string) => void>();
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

function renderLink(
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

describe('ChangesReviewLink', () => {
  it('renders null without a ChangesReviewProvider binding', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const { container } = renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: null,
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when the run made zero journal entries', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const openChangesForRun = mockOpenChangesForRun();
    const { container } = renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun },
      checkpoint: checkpointValue([]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null without a known thread id', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const openChangesForRun = mockOpenChangesForRun();
    const { container } = renderLink(<ChangesReviewLink threadId={undefined} />, {
      changesReview: { openChangesForRun },
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null before the run reaches its terminal run.finished event', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID)];
    const openChangesForRun = mockOpenChangesForRun();
    const { container } = renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun },
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the honest edited-file count and calls openChangesForRun(runId, threadId) on click', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    const openChangesForRun = mockOpenChangesForRun();
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun },
      checkpoint: checkpointValue([
        makeEntry({ id: 'ckpt-1', path: '/a.ts', toolCallId: TOOL_CALL_ID }),
        makeEntry({ id: 'ckpt-2', path: '/b.ts', toolCallId: TOOL_CALL_ID }),
      ]),
    });

    const link = screen.getByTestId('changes-review-link');
    expect(link).toHaveTextContent('2 file edits from this turn');

    fireEvent.click(link);
    expect(openChangesForRun).toHaveBeenCalledWith('run-1', 'thread-1');
  });

  it('uses singular wording for exactly one edit', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun: mockOpenChangesForRun() },
      checkpoint: checkpointValue([makeEntry()]),
    });
    expect(screen.getByTestId('changes-review-link')).toHaveTextContent(
      '1 file edit from this turn'
    );
  });

  // The bug this fix closes: `useCheckpointTurnRevert` excluded non-
  // revertible entries AND required this message to own the run's anchor
  // toolCallId. A run whose only edit is `expired` had no such anchor, so
  // the link could never appear even though the changeset resolver still
  // surfaces the entry.
  it('renders for a run whose only journal entry is non-revertible (expired)', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun: mockOpenChangesForRun() },
      checkpoint: checkpointValue([makeEntry({ captureStatus: 'expired' })]),
    });
    expect(screen.getByTestId('changes-review-link')).toHaveTextContent(
      '1 file edit from this turn'
    );
  });

  it('renders for a run whose only journal entry is already reverted', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun: mockOpenChangesForRun() },
      checkpoint: checkpointValue([makeEntry({ revertedAt: '2026-04-22T10:05:00.000Z' })]),
    });
    expect(screen.getByTestId('changes-review-link')).toHaveTextContent(
      '1 file edit from this turn'
    );
  });

  // The label counts DISTINCT FILES, not journal rows.
  it('counts a file written twice in one run as one file edit, not two', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun: mockOpenChangesForRun() },
      checkpoint: checkpointValue([
        makeEntry({ id: 'ckpt-1', op: 'write', path: '/a.ts' }),
        makeEntry({ id: 'ckpt-2', op: 'string_replace', path: '/a.ts', toolCallId: null }),
      ]),
    });
    expect(screen.getByTestId('changes-review-link')).toHaveTextContent(
      '1 file edit from this turn'
    );
  });

  // Only entries for THIS message's finished runId count — a different run
  // in the same thread's journal must not inflate the total.
  it('counts only entries belonging to this message’s finished runId', () => {
    mockParts = [toolCallPart(TOOL_CALL_ID), runFinishedPart('run-1')];
    renderLink(<ChangesReviewLink threadId="thread-1" />, {
      changesReview: { openChangesForRun: mockOpenChangesForRun() },
      checkpoint: checkpointValue([
        makeEntry({ id: 'ckpt-1', path: '/a.ts', runId: 'run-1' }),
        makeEntry({ id: 'ckpt-2', path: '/b.ts', runId: 'run-2', toolCallId: null }),
      ]),
    });
    expect(screen.getByTestId('changes-review-link')).toHaveTextContent(
      '1 file edit from this turn'
    );
  });
});
