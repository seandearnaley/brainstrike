// ADR-0040: a project memory write shows in its thread as a card: the note's
// title and text, the untrusted mark, and Undo, which asks the host.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import { PROJECT_MEMORY_NOTE_DATA_NAME, type ProjectMemoryNote } from '../project-memory-note';
import { ProjectMemoryNoteCard, ProjectMemoryUndoProvider } from '../project-memory-note-card';

const threadId = 'thread-1';
const runId = 'run-1';

const saved = {
  path: '/memories/test-runtime.md',
  previous: null,
  projectId: 'project-1',
  runId,
  text: "# Test runtime\nThis repo's tests need Node 26.\n",
  title: 'Test runtime',
  toolCallId: 'call-1',
  type: 'memory.changed',
  untrusted: true,
};

/** The memory cards a thread's committed rows project to. */
function projectedNotes(
  events: readonly Readonly<Record<string, unknown>>[]
): readonly ProjectMemoryNote[] {
  const rows: readonly CommittedAssistantLogRow[] = [
    { modelId: 'scripted', prompt: 'Remember the Node version.', runId, type: 'run.started' },
    ...events,
    { outcome: 'completed', runId, type: 'run.finished' },
  ].map((event, index) => ({ event, seq: index + 1, threadId }));
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date('2026-11-14T12:00:00.000Z'),
      parentMessageId: null,
      userMessageId: 'prompt-1',
    }),
    threadId,
  });
  const message = projection
    .acceptCommitted(rows)
    .repository.messages.find(({ message: item }) => item.id === runId)?.message;
  return (message?.content ?? []).flatMap((part) =>
    part.type === 'data' && part.name === PROJECT_MEMORY_NOTE_DATA_NAME
      ? [part.data as ProjectMemoryNote]
      : []
  );
}

describe('the memory card a write projects to', () => {
  it('carries the note, its mark and its call, and is marked undone by Undo', () => {
    const [note] = projectedNotes([saved]);
    expect(note).toMatchObject({
      path: '/memories/test-runtime.md',
      runId,
      text: saved.text,
      title: 'Test runtime',
      toolCallId: 'call-1',
      undoable: true,
      undone: false,
      untrusted: true,
    });

    const undone = projectedNotes([
      saved,
      { commandId: 'undo-1', runId, toolCallId: 'call-1', type: 'memory.undone' },
    ]);
    expect(undone).toHaveLength(1);
    expect(undone[0]?.undone).toBe(true);
  });

  it('carries the reason for a refused note, and nothing it held', () => {
    const [note] = projectedNotes([
      {
        path: '/memories/token.md',
        projectId: 'project-1',
        reason: 'Holds a secret (github-token)',
        runId,
        title: 'Deploy token',
        toolCallId: 'call-2',
        type: 'memory.refused',
      },
    ]);
    expect(note).toMatchObject({
      refusal: 'Holds a secret (github-token)',
      text: null,
      title: 'Deploy token',
      undoable: false,
    });
  });
});

describe('ProjectMemoryNoteCard', () => {
  const [note] = projectedNotes([saved]);
  if (!note) {
    throw new Error('The write projects to a card');
  }

  it('shows the note, the untrusted mark and Undo, which asks the host for this call', async () => {
    const undo = vi.fn(async () => undefined);
    render(
      <ProjectMemoryUndoProvider undo={undo}>
        <ProjectMemoryNoteCard note={note} />
      </ProjectMemoryUndoProvider>
    );

    expect(screen.getByTestId('project-memory-title').textContent).toBe('Test runtime');
    expect(screen.getByTestId('project-memory-text').textContent).toBe(
      "This repo's tests need Node 26."
    );
    expect(screen.getByTestId('project-memory-untrusted').textContent).toBe('Untrusted');
    fireEvent.click(screen.getByTestId('project-memory-undo'));
    await waitFor(() => expect(undo).toHaveBeenCalledWith({ runId, toolCallId: 'call-1' }));
  });

  it('shows why the host refused an Undo', async () => {
    const undo = vi.fn(async () => {
      throw new Error('This note changed after the save, so it was not undone.');
    });
    render(
      <ProjectMemoryUndoProvider undo={undo}>
        <ProjectMemoryNoteCard note={{ ...note, untrusted: false }} />
      </ProjectMemoryUndoProvider>
    );

    expect(screen.queryByTestId('project-memory-untrusted')).toBeNull();
    fireEvent.click(screen.getByTestId('project-memory-undo'));
    expect((await screen.findByTestId('project-memory-undo-failure')).textContent).toBe(
      'This note changed after the save, so it was not undone.'
    );
  });

  it('reads Undone once undone, and offers no Undo without a host', () => {
    const { unmount } = render(<ProjectMemoryNoteCard note={note} />);
    expect(screen.queryByTestId('project-memory-undo')).toBeNull();
    unmount();

    render(
      <ProjectMemoryUndoProvider undo={vi.fn(async () => undefined)}>
        <ProjectMemoryNoteCard note={{ ...note, undone: true }} />
      </ProjectMemoryUndoProvider>
    );
    expect(screen.getByTestId('project-memory-undone').textContent).toBe('Undone');
    expect(screen.queryByTestId('project-memory-undo')).toBeNull();
  });
});
