/**
 * BST-2534: a project's Memory panel, like Notes: the project's notes in a list
 * and the open note's Markdown in an editor. A note untrusted context wrote
 * sorts first with the card's mark; the rest follow, newest first. Leaving an
 * edited note, or the panel, saves it first, and a refused save keeps the text
 * and says why. Delete asks once, here. It explains nothing else.
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
}

const UNREAD: PanelState = {
  confirmingDelete: false,
  draft: '',
  failure: null,
  notes: [],
  opened: null,
  pending: false,
};

/** The notes as the host listed them, untrusted first, then newest, with the first open. */
function listed(
  notes: readonly ProjectMemoryPanelNote[]
): Pick<PanelState, 'draft' | 'notes' | 'opened'> {
  const sorted = [...notes].sort(
    (a, b) =>
      Number(b.untrusted) - Number(a.untrusted) ||
      b.modifiedAt - a.modifiedAt ||
      a.title.localeCompare(b.title)
  );
  const first = sorted[0];
  return { draft: first?.text ?? '', notes: sorted, opened: first ? { path: first.path } : null };
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
  const [state, setState] = useState<PanelState>(UNREAD);
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
        setState((now) => ({ ...now, ...listed(found) }));
      }
    } catch (cause) {
      if (current()) {
        setState((now) => ({ ...now, failure: messageOf(cause) }));
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
  const stored = state.notes.find((note) => note.path === openPath);
  const edited =
    opened === 'new'
      ? state.draft.trim() !== ''
      : stored !== undefined && state.draft !== stored.text;

  /** The change on its way to the host: a close asked for meanwhile waits for it. */
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

  /** Saves the open note's text; false when the host refused, which the panel shows. */
  const save = (): Promise<boolean> => track(write());
  const write = async (): Promise<boolean> => {
    if (opened === null) {
      return true;
    }
    setState((now) => ({ ...now, failure: null, pending: true }));
    try {
      const written = await notes.write(
        opened === 'new' ? { text: state.draft } : { path: opened.path, text: state.draft }
      );
      const found = await notes.list();
      setState((now) => ({
        ...now,
        notes: listed(found).notes,
        opened: { path: written.path },
        pending: false,
      }));
      return true;
    } catch (cause) {
      setState((now) => ({ ...now, failure: messageOf(cause), pending: false }));
      return false;
    }
  };

  /** Opens another note, or a new one, once an edit to the open one is saved. */
  const openNote = async (next: OpenNote): Promise<boolean> => {
    if (state.pending || (edited && !(await save()))) {
      return false;
    }
    flushSync(() => {
      setState((now) => ({
        ...now,
        confirmingDelete: false,
        draft:
          next === null || next === 'new'
            ? ''
            : (now.notes.find((note) => note.path === next.path)?.text ?? ''),
        failure: null,
        opened: next,
      }));
    });
    return true;
  };

  const remove = (): Promise<boolean> => track(deleteOpened());
  const deleteOpened = async (): Promise<boolean> => {
    if (opened === null) {
      return true;
    }
    setState((now) => ({ ...now, failure: null, pending: true }));
    try {
      if (opened !== 'new') {
        await notes.delete(opened.path);
      }
      const found = opened === 'new' ? state.notes : await notes.list();
      const next = listed(found);
      flushSync(() => {
        setState((now) => ({ ...now, ...next, confirmingDelete: false, pending: false }));
      });
      const first = next.opened === null || next.opened === 'new' ? null : next.opened.path;
      (first === null ? newNoteButton.current : rows.current.get(first))?.focus();
      return true;
    } catch (cause) {
      setState((now) => ({
        ...now,
        confirmingDelete: false,
        failure: messageOf(cause),
        pending: false,
      }));
      return false;
    }
  };

  /** Closes once nothing is left unsaved: a change on its way lands first, then an edit saves. */
  const close = async (): Promise<void> => {
    const running = inFlight.current;
    const settled = running ? await running : !edited || (await save());
    if (settled) {
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
                  setState((now) => ({ ...now, draft: value }));
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
                        setState((now) => ({ ...now, confirmingDelete: false }));
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
                        setState((now) => ({ ...now, confirmingDelete: true }));
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
