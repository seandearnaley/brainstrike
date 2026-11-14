/**
 * ADR-0040: the card a project memory write shows in its thread: the note's
 * title and text, the untrusted mark, and Undo. It explains nothing else.
 */
import { Badge, Button, cn } from '@brainstrike/ui';
import { NotebookPen, ShieldAlert } from 'lucide-react';
import { createContext, type ReactElement, type ReactNode, use, useState } from 'react';
import type { ProjectMemoryNote } from './project-memory-note';

/** Restores what one memory write replaced; rejects with why when the host refuses. */
export type ProjectMemoryUndo = (call: {
  readonly runId: string;
  readonly toolCallId: string;
}) => Promise<void>;

const ProjectMemoryUndoContext = createContext<ProjectMemoryUndo | null>(null);

/** The host's Undo for the cards below; without one, no card offers Undo. */
export function ProjectMemoryUndoProvider({
  children,
  undo,
}: {
  readonly children: ReactNode;
  readonly undo: ProjectMemoryUndo;
}): ReactElement {
  return (
    <ProjectMemoryUndoContext.Provider value={undo}>{children}</ProjectMemoryUndoContext.Provider>
  );
}

/** The note's text below its title: the `# Title` line it starts with is the title. */
function noteBody(note: ProjectMemoryNote): string {
  const lines = (note.text ?? '').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first === -1 ? undefined : /^#\s+(.+)$/u.exec(lines[first]?.trim() ?? '');
  return (heading?.[1]?.trim() === note.title ? lines.slice(first + 1) : lines).join('\n').trim();
}

function UndoControl({ note }: { readonly note: ProjectMemoryNote }): ReactElement | null {
  const undo = use(ProjectMemoryUndoContext);
  const [phase, setPhase] = useState<'idle' | 'undoing'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  if (note.undone) {
    return (
      <span className="text-muted-foreground shrink-0 text-xs" data-testid="project-memory-undone">
        Undone
      </span>
    );
  }
  if (!(undo && note.undoable)) {
    return null;
  }
  const run = async (): Promise<void> => {
    setPhase('undoing');
    setFailure(null);
    try {
      await undo({ runId: note.runId, toolCallId: note.toolCallId });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPhase('idle');
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-2">
      {failure && (
        <span className="text-destructive text-xs" data-testid="project-memory-undo-failure">
          {failure}
        </span>
      )}
      <Button
        className="h-6 px-2 text-xs"
        data-testid="project-memory-undo"
        disabled={phase === 'undoing'}
        onClick={() => {
          void run();
        }}
        size="sm"
        variant="ghost"
      >
        Undo
      </Button>
    </span>
  );
}

export function ProjectMemoryNoteCard({
  note,
}: {
  readonly note: ProjectMemoryNote;
}): ReactElement {
  const body = noteBody(note);
  const deleted = note.text === null && note.refusal === undefined;
  return (
    <section
      aria-label={`Memory: ${note.title}`}
      className="border-border bg-muted/40 w-full max-w-2xl rounded-lg border px-3 py-2"
      data-memory-path={note.path}
      data-testid="project-memory-note"
    >
      <div className="flex items-center gap-2">
        <NotebookPen aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-medium',
            (deleted || note.undone) && 'text-muted-foreground line-through'
          )}
          data-testid="project-memory-title"
        >
          {note.title}
        </span>
        {note.untrusted && (
          <Badge
            className="shrink-0 gap-1"
            data-testid="project-memory-untrusted"
            variant="outline"
          >
            <ShieldAlert aria-hidden="true" className="size-3" />
            Untrusted
          </Badge>
        )}
        <UndoControl note={note} />
      </div>
      {note.refusal !== undefined && (
        <p className="text-destructive mt-1 text-xs" data-testid="project-memory-refusal">
          {note.refusal}
        </p>
      )}
      {body !== '' && !deleted && (
        <p
          className={cn(
            'text-muted-foreground mt-1 text-sm leading-6 break-words whitespace-pre-wrap',
            note.undone && 'line-through'
          )}
          data-testid="project-memory-text"
        >
          {body}
        </p>
      )}
    </section>
  );
}
