/**
 * BST-2534: a project's Memory panel, like Notes: the project's notes in a list
 * and the open note's Markdown in an editor. A note untrusted context wrote
 * sorts first with the card's mark; the rest follow, newest first. Leaving an
 * edited note, or the panel, saves it first, unless the text is what the host
 * just said no to: the reason shows once, the text stays, and the person can
 * always leave. Delete asks once, here. It explains nothing else.
 *
 * It reads the notes when it opens: mount one per opening (a new `key`), and
 * keep it mounted while it closes, so it closes as any dialog does.
 */
import { Button, cn, Dialog, DialogContent, DialogHeader, DialogTitle } from '@brainstrike/ui';
import { Plus } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { ProjectMemoryUntrustedMark } from './project-memory-note-card';
import { formatAbsoluteDate } from './relative-time';

export interface ProjectMemoryPanelNote {
  readonly modifiedAt: number;
  readonly path: string;
  readonly text: string;
  readonly title: string;
  readonly untrusted: boolean;
}

/** One project's notes, which the host keeps; each call rejects with the host's refusal. */
export interface ProjectMemoryPanelNotes {
  delete(path: string): Promise<void>;
  list(): Promise<readonly ProjectMemoryPanelNote[]>;
  /** Replaces the note at `path`, or without one makes a note; resolves the note written. */
  write(note: { readonly path?: string; readonly text: string }): Promise<ProjectMemoryPanelNote>;
}

/** The open note: a stored one by its path, a new one not saved yet, or none. */
type OpenNote = { readonly path: string } | 'new' | null;

interface PanelState {
  readonly confirmingDelete: boolean;
  readonly draft: string;
  readonly failure: string | null;
  readonly notes: readonly ProjectMemoryPanelNote[];
  readonly opened: OpenNote;
  readonly pending: boolean;
  /** The open note's text the host last said no to: leaving with it does not try again. */
  readonly refused: string | null;
}

const UNREAD: PanelState = {
  confirmingDelete: false,
  draft: '',
  failure: null,
  notes: [],
  opened: null,
  pending: false,
  refused: null,
};

/** Untrusted notes first, then the newest. */
function ordered(notes: readonly ProjectMemoryPanelNote[]): readonly ProjectMemoryPanelNote[] {
  return [...notes].sort(
    (a, b) =>
      Number(b.untrusted) - Number(a.untrusted) ||
      b.modifiedAt - a.modifiedAt ||
      a.title.localeCompare(b.title)
  );
}

/** The notes in the panel's order, with the first one open. */
function firstOpen(
  notes: readonly ProjectMemoryPanelNote[]
): Pick<PanelState, 'draft' | 'notes' | 'opened' | 'refused'> {
  const sorted = ordered(notes);
  const first = sorted[0];
  return {
    draft: first?.text ?? '',
    notes: sorted,
    opened: first ? { path: first.path } : null,
    refused: null,
  };
}

/** Whether the open note's text differs from what the host holds. */
function isEdited({ draft, notes, opened }: PanelState): boolean {
  if (opened === null) {
    return false;
  }
  if (opened === 'new') {
    return draft.trim() !== '';
  }
  const held = notes.find((note) => note.path === opened.path)?.text;
  return held !== undefined && draft !== held;
}

/**
 * Whether leaving the open note saves it first: it was edited, and not to the text the host
 * just said no to. So a refusal shows once, and the person can always leave.
 */
function leavesUnsaved(state: PanelState): boolean {
  return isEdited(state) && state.draft !== state.refused;
}

/** The row a key moves to from row `at` of `0..last`; undefined for any other key. */
function rowAfterKey(key: string, at: number, last: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return Math.min(at + 1, last);
    case 'ArrowUp':
      return Math.max(at - 1, 0);
    case 'End':
      return last;
    case 'Home':
      return 0;
    default:
      return;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ProjectMemoryPanel({
  notes,
  onOpenChange,
  open,
  title,
  triggerRef,
}: {
  readonly notes: ProjectMemoryPanelNotes;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** Names the project. */
  readonly title: string;
  /** What takes focus back when the panel closes: the control that opened it. */
  readonly triggerRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const [state, setRendered] = useState<PanelState>(UNREAD);
  /** The state as of the last change: what a step reads once a request comes back. */
  const latest = useRef(UNREAD);
  const update = (change: (now: PanelState) => PanelState): void => {
    latest.current = change(latest.current);
    setRendered(latest.current);
  };
  const newNoteButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());

  // Read once per opening, whichever object the caller passes on later renders.
  const read = useEffectEvent(async (current: () => boolean): Promise<void> => {
    try {
      const found = await notes.list();
      if (current()) {
        // A note the person opened before the list came stays open; the list fills in beside it.
        update((now) =>
          now.opened === null ? { ...now, ...firstOpen(found) } : { ...now, notes: ordered(found) }
        );
      }
    } catch (cause) {
      if (current()) {
        update((now) => ({ ...now, failure: messageOf(cause) }));
      }
    }
  });
  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    void read(() => current);
    return () => {
      current = false;
    };
  }, [open]);

  const { opened } = state;
  const openPath = opened !== null && opened !== 'new' ? opened.path : null;
  const edited = isEdited(state);

  /** The change on its way to the host: leaving waits for it. */
  const inFlight = useRef<Promise<boolean> | null>(null);
  const track = (change: Promise<boolean>): Promise<boolean> => {
    inFlight.current = change;
    void change.finally(() => {
      if (inFlight.current === change) {
        inFlight.current = null;
      }
    });
    return change;
  };

  /** Saves the open note's text; false when the host said no, which the panel shows. */
  const save = (): Promise<boolean> => track(write(latest.current));
  const write = async ({ draft, opened: note }: PanelState): Promise<boolean> => {
    if (note === null) {
      return true;
    }
    update((now) => ({ ...now, failure: null, pending: true }));
    try {
      const written = await notes.write(
        note === 'new' ? { text: draft } : { path: note.path, text: draft }
      );
      // What was typed while the save was on its way stays in the draft, still to save.
      update((now) => ({
        ...now,
        notes: ordered([...now.notes.filter((held) => held.path !== written.path), written]),
        opened: { path: written.path },
        pending: false,
        refused: null,
      }));
      return true;
    } catch (cause) {
      update((now) => ({ ...now, failure: messageOf(cause), pending: false, refused: draft }));
      return false;
    }
  };

  /**
   * Before the open note is left: lands the change on its way, then saves an edit made since,
   * unless it is the text the host just said no to. False when the host says no now.
   */
  const settle = async (): Promise<boolean> => {
    for (let running = inFlight.current; running; running = inFlight.current) {
      if (!(await running)) {
        return false;
      }
    }
    return !leavesUnsaved(latest.current) || (await save());
  };

  /** Opens another note, or a new one, once the open one is settled. */
  const openNote = async (next: OpenNote): Promise<boolean> => {
    if (!(await settle())) {
      return false;
    }
    flushSync(() => {
      update((now) => ({
        ...now,
        confirmingDelete: false,
        draft:
          next === null || next === 'new'
            ? ''
            : (now.notes.find((note) => note.path === next.path)?.text ?? ''),
        failure: null,
        opened: next,
        refused: null,
      }));
    });
    return true;
  };

  const remove = (): Promise<boolean> => track(deleteOpened(latest.current));
  const deleteOpened = async ({ opened: note }: PanelState): Promise<boolean> => {
    if (note === null) {
      return true;
    }
    update((now) => ({ ...now, failure: null, pending: true }));
    try {
      if (note !== 'new') {
        await notes.delete(note.path);
      }
      const gone = note === 'new' ? null : note.path;
      const next = firstOpen(latest.current.notes.filter((held) => held.path !== gone));
      flushSync(() => {
        update((now) => ({ ...now, ...next, confirmingDelete: false, pending: false }));
      });
      const first = next.opened === null || next.opened === 'new' ? null : next.opened.path;
      (first === null ? newNoteButton.current : rows.current.get(first))?.focus();
      return true;
    } catch (cause) {
      update((now) => ({
        ...now,
        confirmingDelete: false,
        failure: messageOf(cause),
        pending: false,
      }));
      return false;
    }
  };

  /** Closes once the open note is settled; when the host says no, the reason shows first. */
  const close = async (): Promise<void> => {
    if (await settle()) {
      onOpenChange(false);
    }
  };

  /** Arrows, Home and End move through the notes, opening each. */
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = state.notes.findIndex((note) => note.path === openPath);
    const index = rowAfterKey(event.key, at, state.notes.length - 1);
    if (index === undefined) {
      return;
    }
    event.preventDefault();
    const target = state.notes[index];
    if (target && index !== at) {
      void openNote({ path: target.path }).then((moved) => {
        if (moved) {
          rows.current.get(target.path)?.focus();
        }
      });
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          void close();
        }
      }}
      open={open}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(36rem,calc(100vh-4rem))] flex-col sm:max-w-3xl"
        data-testid="project-memory-panel"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-56 shrink-0 flex-col gap-2">
            <Button
              className="justify-start"
              disabled={state.pending}
              onClick={() => {
                void openNote('new').then((opening) => {
                  if (opening) {
                    editor.current?.focus();
                  }
                });
              }}
              ref={newNoteButton}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" />
              New note
            </Button>
            {state.notes.length > 0 ? (
              <div
                aria-label="Notes"
                className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 py-0.5"
                role="listbox"
              >
                {state.notes.map((note, index) => {
                  const selected = note.path === openPath;
                  return (
                    <div
                      aria-selected={selected}
                      className={cn(
                        'focus-visible:ring-ring grid cursor-default gap-0.5 rounded-md px-2 py-1.5 outline-hidden focus-visible:ring-2',
                        selected ? 'bg-accent' : 'hover:bg-accent/60'
                      )}
                      data-memory-path={note.path}
                      key={note.path}
                      onClick={() => {
                        void openNote({ path: note.path });
                      }}
                      onKeyDown={onRowKeyDown}
                      ref={(row) => {
                        if (row) {
                          rows.current.set(note.path, row);
                        } else {
                          rows.current.delete(note.path);
                        }
                      }}
                      role="option"
                      tabIndex={selected || (openPath === null && index === 0) ? 0 : -1}
                    >
                      <span
                        className="truncate text-sm font-medium"
                        data-testid="project-memory-row-title"
                      >
                        {note.title}
                      </span>
                      {/* One height for every row, the mark's or not. */}
                      <span className="flex h-5 min-w-0 items-center gap-1.5">
                        <span className="text-muted-foreground text-2xs">
                          {formatAbsoluteDate(note.modifiedAt)}
                        </span>
                        {note.untrusted ? <ProjectMemoryUntrustedMark /> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          {opened === null ? null : (
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <textarea
                aria-label="Note"
                className="bg-background focus-visible:ring-ring min-h-0 flex-1 resize-none rounded-md border p-3 font-mono text-xs leading-5 outline-hidden focus-visible:ring-2"
                onChange={(event) => {
                  const { value } = event.target;
                  update((now) => ({ ...now, draft: value }));
                }}
                ref={editor}
                spellCheck={false}
                value={state.draft}
              />
              {state.confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-destructive me-auto text-xs">Delete this note?</span>
                  <Button
                    onClick={() => {
                      flushSync(() => {
                        update((now) => ({ ...now, confirmingDelete: false }));
                      });
                      deleteButton.current?.focus();
                    }}
                    ref={cancelButton}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={state.pending}
                    onClick={() => {
                      void remove();
                    }}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    Delete
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    disabled={state.pending}
                    onClick={() => {
                      if (opened === 'new') {
                        void remove();
                        return;
                      }
                      flushSync(() => {
                        update((now) => ({ ...now, confirmingDelete: true }));
                      });
                      cancelButton.current?.focus();
                    }}
                    ref={deleteButton}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Delete
                  </Button>
                  <Button
                    disabled={!edited || state.pending}
                    onClick={() => {
                      // Saved, Save is disabled; the editor keeps focus so typing and Escape go on.
                      void save().then((saved) => {
                        if (saved) {
                          editor.current?.focus();
                        }
                      });
                    }}
                    size="sm"
                    type="button"
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        {state.failure ? (
          <p className="text-destructive text-xs" role="alert">
            {state.failure}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
