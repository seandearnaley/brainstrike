/**
 * Every changed file in one scroll (ADR-0036): @pierre/diffs' `CodeView`
 * virtualizes the files, keeps each header stuck while its diff scrolls, and
 * draws git's patch as it is. A file's unchanged lines expand from the full
 * sides `loadFile` returns; a file the view sent without a patch stays folded
 * until it is opened, then loads.
 *
 * Files start open, or folded where the view only lists them (a turn's
 * changes in the chat); a person opens or folds each one from its header.
 *
 * Comments are drafts the caller owns: a + on a line, or a drag down the
 * gutter, opens one box at a time under the last line, and the saved comment
 * stays on the diff until the caller removes it.
 *
 * Each file's own actions show on its header, and on each hunk of a modified
 * file whose whole patch the diff holds, under the hunk's last change
 * (@pierre/diffs' accept/reject pattern). A hunk action hands back the hunk
 * exactly as git's patch has it.
 */
import {
  actionHunks,
  type ChangedFileStatus,
  type ChangesAction,
  type StructuredFileDiff,
} from '@brainstrike/types';
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import {
  CodeView,
  type CodeViewAnnotationArgs,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from '@pierre/diffs/react';
import { ChevronRight, Loader2, type LucideIcon, Minus, Plus, Undo2 } from 'lucide-react';
import {
  type ReactElement,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { TooltipIconButton } from '../tooltip-icon-button';
import { toast } from '../use-toast';
import { CHANGES_ACTION_LABEL, CHANGES_ACTIONS } from './changes-actions';
import { useDiffAppearance } from './diff-appearance';
import {
  type DiffSide,
  emptyFileDiff,
  lastChangedLine,
  loadedFileDiff,
  parseFilePatch,
  sideLines,
  sidesOf,
} from './diff-metadata';
import {
  type DiffComment,
  DiffCommentComposer,
  DiffCommentNote,
  type DiffCommentTarget,
} from './diff-review-comment';

export interface DiffReviewFile {
  /** What the caller applies to this file. Without `onAction` the diff offers none. */
  readonly actions: readonly ChangesAction[];
  /** Null when git counts no lines: a binary file. */
  readonly additions: number | null;
  readonly deletions: number | null;
  /** Stable across reloads of the same view. */
  readonly id: string;
  readonly oldPath?: string | undefined;
  /** Git's diff of the file, or null when the view sent none. */
  readonly patch: string | null;
  readonly path: string;
  /** Identity of what the caller drew; a diff loaded at another revision is not shown. */
  readonly revision: string;
  readonly status: ChangedFileStatus;
}

export interface DiffReviewHandle {
  scrollToFile(id: string): void;
}

const CHANGES_ACTION_ICON: Readonly<Record<ChangesAction, LucideIcon>> = {
  revert: Undo2,
  stage: Plus,
  unstage: Minus,
};

export interface DiffReviewProps {
  /** True while an action runs: every action control is disabled. */
  readonly actionsDisabled?: boolean | undefined;
  /** Sizes the scroll region; it fills its parent otherwise. */
  readonly className?: string | undefined;
  readonly comments?: readonly DiffComment[] | undefined;
  /** Every file starts folded to its header. */
  readonly defaultCollapsed?: boolean | undefined;
  readonly diffStyle: 'split' | 'unified';
  readonly files: readonly DiffReviewFile[];
  /** One file's diff with both sides; rejects with why it could not load. */
  readonly loadFile: (id: string) => Promise<StructuredFileDiff>;
  /** Applies an action to the whole file (`hunks` null) or to hunks quoted from its patch. */
  readonly onAction?:
    | ((action: ChangesAction, file: DiffReviewFile, hunks: readonly string[] | null) => void)
    | undefined;
  /** Saves a new or edited comment. Without it the diff takes none. */
  readonly onComment?: ((comment: DiffComment) => void) | undefined;
  readonly onDeleteComment?: ((id: string) => void) | undefined;
  readonly ref?: Ref<DiffReviewHandle> | undefined;
}

type Note =
  | { readonly comment: DiffComment; readonly kind: 'comment' }
  | { readonly kind: 'draft' }
  | { readonly actions: readonly ChangesAction[]; readonly hunk: number; readonly kind: 'hunk' };

interface Draft {
  /** The comment being edited, or null for a new one. */
  readonly commentId: string | null;
  readonly target: DiffCommentTarget;
  readonly text: string;
}

/** A file loaded on demand: its diff, or null for a binary file, and git's counts. */
interface LoadedFile {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly fileDiff: FileDiffMetadata | null;
  /** Its patch's hunks, or null without a whole patch or when no hunk stands alone. */
  readonly hunks: readonly string[] | null;
  /** The file's revision when the read started. */
  readonly revision: string;
  readonly truncated: boolean;
}

const NO_ACTIONS: readonly ChangesAction[] = [];
const NO_COMMENTS: readonly DiffComment[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
const NO_LOADED: ReadonlyMap<string, LoadedFile> = new Map();

/**
 * Numstat gives a binary file no counts. An untracked file has no numstat, so
 * its missing counts only mean the view did not diff it.
 */
function isBinary(file: DiffReviewFile, loaded: LoadedFile | undefined): boolean {
  if (loaded) {
    return loaded.fileDiff === null;
  }
  return file.patch === null && file.additions === null && file.status !== 'untracked';
}

/**
 * The file's loaded diff while the view sends the file without its patch, at
 * the revision it was loaded for. Once the view carries a patch, or the file
 * reads differently, the loaded diff is an older version.
 */
function loadedOf(
  file: DiffReviewFile,
  loaded: ReadonlyMap<string, LoadedFile>
): LoadedFile | undefined {
  const entry = file.patch === null ? loaded.get(file.id) : undefined;
  return entry?.revision === file.revision ? entry : undefined;
}

/** The file's actions, in the order their controls show. */
function offeredActions(file: DiffReviewFile): readonly ChangesAction[] {
  return CHANGES_ACTIONS.filter((action) => file.actions.includes(action));
}

/** A text file the view sent without its patch, not loaded yet. */
function isUnloaded(file: DiffReviewFile, loaded: LoadedFile | undefined): boolean {
  return loaded === undefined && file.patch === null && !isBinary(file, undefined);
}

function toastLoadFailure(file: DiffReviewFile, error: unknown): void {
  toast({
    description: messageOf(error),
    title: `Couldn't load ${file.path}`,
    variant: 'destructive',
  });
}

function targetOf(comment: DiffComment): DiffCommentTarget {
  const { endLine, fileId, lines, side, startLine } = comment;
  return { endLine, fileId, lines, side, startLine };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toggled(
  ids: ReadonlySet<string>,
  id: string,
  present = !ids.has(id)
): ReadonlySet<string> {
  const next = new Set(ids);
  if (present) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

/**
 * What CodeView needs kept between renders: one parsed diff per file, so the
 * unchanged lines a person expanded stay expanded, and one version per item,
 * which moves only when the item's diff, fold or notes change.
 */
interface Parsed {
  readonly fileDiff: FileDiffMetadata;
  /** The patch's hunks, quoted, or null without a patch or when no hunk stands alone. */
  readonly hunks: readonly string[] | null;
  /** The patch it was parsed from, or the file's identity when it has none. */
  readonly source: string;
}

interface Versioned {
  readonly collapsed: boolean;
  readonly fileDiff: FileDiffMetadata;
  readonly notes: string;
  readonly version: number;
}

class ReviewItems {
  readonly #ids = new WeakMap<FileDiffMetadata, string>();
  #hunks = new Map<string, readonly string[] | null>();
  #parsed = new Map<string, Parsed>();
  #versions = new Map<string, Versioned>();

  idOf(fileDiff: FileDiffMetadata): string | undefined {
    return this.#ids.get(fileDiff);
  }

  /** The hunks of the patch a file's diff draws, quoted. */
  hunksOf(id: string): readonly string[] | null {
    return this.#hunks.get(id) ?? null;
  }

  build(
    files: readonly DiffReviewFile[],
    loaded: ReadonlyMap<string, LoadedFile>,
    isFolded: (id: string) => boolean,
    notesOf: (
      file: DiffReviewFile,
      fileDiff: FileDiffMetadata,
      hunks: readonly string[] | null
    ) => DiffLineAnnotation<Note>[]
  ): CodeViewDiffItem<Note>[] {
    const hunksById = new Map<string, readonly string[] | null>();
    const parsed = new Map<string, Parsed>();
    const versions = new Map<string, Versioned>();
    const items = files.map((file) => {
      const load = loadedOf(file, loaded);
      const { fileDiff, hunks } = load?.fileDiff
        ? { fileDiff: load.fileDiff, hunks: load.hunks }
        : this.#parse(file, load, parsed);
      hunksById.set(file.id, hunks);
      const collapsed = isFolded(file.id) || isUnloaded(file, load);
      const annotations = notesOf(file, fileDiff, hunks);
      const notes = JSON.stringify(annotations);
      const previous = this.#versions.get(file.id);
      const version =
        previous &&
        previous.fileDiff === fileDiff &&
        previous.collapsed === collapsed &&
        previous.notes === notes
          ? previous.version
          : (previous?.version ?? -1) + 1;
      versions.set(file.id, { collapsed, fileDiff, notes, version });
      this.#ids.set(fileDiff, file.id);
      return { annotations, collapsed, fileDiff, id: file.id, type: 'diff', version } as const;
    });
    this.#hunks = hunksById;
    this.#parsed = parsed;
    this.#versions = versions;
    return items;
  }

  #parse(file: DiffReviewFile, load: LoadedFile | undefined, parsed: Map<string, Parsed>): Parsed {
    const patch = load === undefined ? file.patch : null;
    const source = patch ?? `\u0000${file.status}\u0000${file.oldPath ?? ''}\u0000${file.path}`;
    const previous = this.#parsed.get(file.id);
    const next =
      previous?.source === source
        ? previous
        : patch === null
          ? { fileDiff: emptyFileDiff(file.path, file.oldPath, file.status), hunks: null, source }
          : { fileDiff: parseFilePatch(patch), hunks: actionHunks(patch), source };
    parsed.set(file.id, next);
    return next;
  }
}

function FileStats({
  additions,
  binary,
  deletions,
  truncated,
}: {
  readonly additions: number | null;
  readonly binary: boolean;
  readonly deletions: number | null;
  readonly truncated: boolean;
}): ReactElement | null {
  if (binary) {
    return <span className="text-muted-foreground shrink-0">Binary</span>;
  }
  if (additions === null || deletions === null) {
    return null;
  }
  return (
    <span className="shrink-0 font-mono tabular-nums" data-testid="diff-review-file-stats">
      {truncated ? <span className="text-muted-foreground mr-2 font-sans">Truncated</span> : null}
      <span aria-hidden="true">
        <span className="text-success">+{additions}</span>{' '}
        <span className="text-destructive">−{deletions}</span>
      </span>
      <span className="sr-only">
        {additions} additions, {deletions} deletions
      </span>
    </span>
  );
}

/** A hunk's actions, under its last change. */
function HunkActions({
  actions,
  disabled,
  onAction,
}: {
  readonly actions: readonly ChangesAction[];
  readonly disabled: boolean;
  readonly onAction: (action: ChangesAction) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap justify-end gap-1 px-3 py-1 font-sans">
      {actions.map((action) => (
        <Button
          disabled={disabled}
          key={action}
          onClick={() => onAction(action)}
          size="xs"
          type="button"
          variant="outline"
        >
          {CHANGES_ACTION_LABEL[action]}
        </Button>
      ))}
    </div>
  );
}

function FileHeader({
  actions,
  actionsDisabled,
  binary,
  expandable,
  file,
  loadedFile,
  loading,
  onAction,
  onToggle,
  open,
}: {
  readonly actions: readonly ChangesAction[];
  readonly actionsDisabled: boolean;
  readonly binary: boolean;
  readonly expandable: boolean;
  readonly file: DiffReviewFile;
  readonly loadedFile: LoadedFile | undefined;
  readonly loading: boolean;
  readonly onAction: (action: ChangesAction) => void;
  readonly onToggle: () => void;
  readonly open: boolean;
}): ReactElement {
  const counts = loadedFile ?? file;
  const name = (
    <span className="truncate font-mono">
      {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    </span>
  );
  return (
    <div
      className="border-border bg-background flex h-11 items-center gap-2 border-b px-2 font-sans text-xs"
      data-testid="diff-review-file-header"
    >
      {expandable ? (
        <button
          aria-expanded={open}
          className="hover:bg-accent flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left"
          disabled={loading}
          onClick={onToggle}
          type="button"
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
            />
          )}
          {name}
        </button>
      ) : (
        <div className="flex h-7 min-w-0 flex-1 items-center pl-6">{name}</div>
      )}
      <FileStats
        additions={counts.additions}
        binary={binary}
        deletions={counts.deletions}
        truncated={loadedFile?.truncated ?? false}
      />
      {actions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions.map((action) => {
            const Icon = CHANGES_ACTION_ICON[action];
            return (
              <TooltipIconButton
                aria-label={`${CHANGES_ACTION_LABEL[action]} ${file.path}`}
                disabled={actionsDisabled}
                key={action}
                onClick={() => onAction(action)}
                tooltip={CHANGES_ACTION_LABEL[action]}
              >
                <Icon aria-hidden="true" />
              </TooltipIconButton>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function DiffReview({
  actionsDisabled = false,
  className,
  comments = NO_COMMENTS,
  defaultCollapsed = false,
  diffStyle,
  files,
  loadFile,
  onAction,
  onComment,
  onDeleteComment,
  ref,
}: DiffReviewProps): ReactElement {
  const appearance = useDiffAppearance();
  const viewer = useRef<CodeViewHandle<Note, undefined> | null>(null);
  const [cache] = useState(() => new ReviewItems());
  /** Files a person opened or folded away from where they start. */
  const [toggledIds, setToggledIds] = useState(NO_IDS);
  const [loadingIds, setLoadingIds] = useState(NO_IDS);
  const [loaded, setLoaded] = useState(NO_LOADED);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The latest read of each file, so an older read never lands after a newer one. */
  const reads = useRef(new Map<string, number>());

  useImperativeHandle(
    ref,
    () => ({
      scrollToFile: (id) => viewer.current?.scrollTo({ align: 'start', id, type: 'item' }),
    }),
    []
  );

  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const draftTarget = draft?.target;
  const draftCommentId = draft?.commentId;
  const actionable = onAction !== undefined;

  const fold = (id: string, folded: boolean): void =>
    setToggledIds((current) => toggled(current, id, folded !== defaultCollapsed));

  const items = useMemo(
    () =>
      cache.build(
        files,
        loaded,
        (id) => toggledIds.has(id) !== defaultCollapsed,
        (file, fileDiff, hunks) => {
          const notes: DiffLineAnnotation<Note>[] = comments
            .filter((comment) => comment.fileId === file.id && comment.id !== draftCommentId)
            .map((comment) => ({
              lineNumber: comment.endLine,
              metadata: { comment, kind: 'comment' },
              side: comment.side,
            }));
          if (draftTarget?.fileId === file.id) {
            notes.push({
              lineNumber: draftTarget.endLine,
              metadata: { kind: 'draft' },
              side: draftTarget.side,
            });
          }
          const actions = actionable ? offeredActions(file) : NO_ACTIONS;
          if (actions.length > 0 && file.status === 'modified' && hunks) {
            fileDiff.hunks.forEach((hunk, index) => {
              const end = lastChangedLine(hunk, diffStyle);
              if (end && hunks[index] !== undefined) {
                notes.push({ ...end, metadata: { actions, hunk: index, kind: 'hunk' } });
              }
            });
          }
          return notes;
        }
      ),
    [
      actionable,
      cache,
      comments,
      defaultCollapsed,
      diffStyle,
      draftCommentId,
      draftTarget,
      files,
      loaded,
      toggledIds,
    ]
  );

  /**
   * One file's diff, or null when a newer read of the file started while this
   * one ran: only the newest read is shown, or reports its failure.
   */
  const readFile = async (file: DiffReviewFile): Promise<LoadedFile | null> => {
    const read = (reads.current.get(file.id) ?? 0) + 1;
    reads.current.set(file.id, read);
    const newest = () => reads.current.get(file.id) === read;
    try {
      const diff = await loadFile(file.id);
      const { content } = diff;
      const truncated = content.kind === 'hunks-only' && content.patchTruncated;
      return newest()
        ? {
            additions: diff.additions,
            deletions: diff.deletions,
            fileDiff: loadedFileDiff(diff),
            hunks: content.kind === 'binary' || truncated ? null : actionHunks(content.patch),
            revision: file.revision,
            truncated,
          }
        : null;
    } catch (error) {
      if (newest()) {
        throw error;
      }
      return null;
    }
  };
  const showLoaded = (file: DiffReviewFile, entry: LoadedFile | null): void => {
    if (entry) {
      setLoaded((current) => new Map(current).set(file.id, entry));
    }
  };

  const load = async (file: DiffReviewFile): Promise<void> => {
    setLoadingIds((current) => toggled(current, file.id, true));
    try {
      showLoaded(file, await readFile(file));
    } catch (error) {
      toastLoadFailure(file, error);
    } finally {
      setLoadingIds((current) => toggled(current, file.id, false));
    }
  };

  // A refresh never leaves an opened file on an older version: a file the
  // view still sends without its patch, opened or opening, loads again
  // (`loadedOf` covers the rest). At the same revision it keeps what it
  // showed until the new diff arrives; at a new one it folds until then.
  const openedWithoutPatch = useEffectEvent((current: readonly DiffReviewFile[]) =>
    current.filter(
      (file) => file.patch === null && (loaded.has(file.id) || loadingIds.has(file.id))
    )
  );
  useEffect(() => {
    for (const file of openedWithoutPatch(files)) {
      readFile(file).then(
        (entry) => showLoaded(file, entry),
        (error: unknown) => toastLoadFailure(file, error)
      );
    }
  }, [files]);

  const loadDiffFiles = async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const id = cache.idOf(fileDiff);
    const path = (id && fileById.get(id)?.path) ?? fileDiff.name;
    try {
      if (id === undefined) {
        throw new Error('The file is no longer in this view.');
      }
      const sides = sidesOf(await loadFile(id));
      if (!sides) {
        throw new Error('The file is too large to show in full.');
      }
      return sides;
    } catch (error) {
      toast({
        description: messageOf(error),
        title: `Couldn't expand ${path}`,
        variant: 'destructive',
      });
      throw error;
    }
  };

  const openComment = (range: SelectedLineRange, item: CodeViewItem<Note>): void => {
    if (item.type !== 'diff') {
      return;
    }
    const side: DiffSide = range.endSide ?? range.side ?? 'additions';
    const oneSide = (range.side ?? side) === side;
    const startLine = oneSide ? Math.min(range.start, range.end) : range.end;
    const endLine = oneSide ? Math.max(range.start, range.end) : range.end;
    setDraft({
      commentId: null,
      target: {
        endLine,
        fileId: item.id,
        lines: sideLines(item.fileDiff, side, startLine, endLine),
        side,
        startLine,
      },
      text: '',
    });
  };

  const saveDraft = (): void => {
    const text = draft?.text.trim();
    if (!(draft && text && onComment)) {
      return;
    }
    onComment({ ...draft.target, id: draft.commentId ?? crypto.randomUUID(), text });
    setDraft(null);
  };

  const options: CodeViewReactOptions<Note, undefined> = {
    ...appearance,
    diffStyle,
    enableGutterUtility: onComment !== undefined,
    loadDiffFiles,
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { readonly item: CodeViewItem<Note> }
    ) => openComment(range, context.item),
    stickyHeaders: true,
  };

  const renderHeader = (item: CodeViewItem<Note>): ReactElement | null => {
    const file = fileById.get(item.id);
    if (!file || item.type !== 'diff') {
      return null;
    }
    const loadedFile = loadedOf(file, loaded);
    const binary = isBinary(file, loadedFile);
    const unloaded = isUnloaded(file, loadedFile);
    return (
      <FileHeader
        actions={actionable ? offeredActions(file) : NO_ACTIONS}
        actionsDisabled={actionsDisabled}
        binary={binary}
        expandable={!binary && (unloaded || item.fileDiff.hunks.length > 0)}
        file={file}
        loadedFile={loadedFile}
        loading={loadingIds.has(file.id)}
        onAction={(action) => onAction?.(action, file, null)}
        onToggle={() => {
          if (unloaded) {
            // Opens once it loads, whichever way the files start.
            fold(file.id, false);
            void load(file);
          } else {
            fold(file.id, !item.collapsed);
          }
        }}
        open={!item.collapsed}
      />
    );
  };

  const renderAnnotation = (
    ...[annotation, , item]: CodeViewAnnotationArgs<Note>
  ): ReactElement | null => {
    const note = annotation.metadata;
    if (note.kind === 'hunk') {
      const file = fileById.get(item.id);
      const hunk = cache.hunksOf(item.id)?.[note.hunk];
      return file && hunk !== undefined ? (
        <HunkActions
          actions={note.actions}
          disabled={actionsDisabled}
          onAction={(action) => onAction?.(action, file, [hunk])}
        />
      ) : null;
    }
    if (note.kind === 'draft') {
      return draft ? (
        <DiffCommentComposer
          onCancel={() => setDraft(null)}
          onChange={(text) => setDraft((current) => current && { ...current, text })}
          onSave={saveDraft}
          target={draft.target}
          text={draft.text}
        />
      ) : null;
    }
    return (
      <DiffCommentNote
        comment={note.comment}
        onDelete={() => onDeleteComment?.(note.comment.id)}
        onEdit={() =>
          setDraft({
            commentId: note.comment.id,
            target: targetOf(note.comment),
            text: note.comment.text,
          })
        }
      />
    );
  };

  return (
    <div className="h-full min-h-0" data-testid="diff-review">
      <CodeView<Note, undefined>
        className={cn('h-full overflow-auto overscroll-y-contain', className)}
        items={items}
        options={options}
        ref={viewer}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderHeader}
        selectedLines={
          draft
            ? {
                id: draft.target.fileId,
                range: {
                  end: draft.target.endLine,
                  endSide: draft.target.side,
                  side: draft.target.side,
                  start: draft.target.startLine,
                },
              }
            : null
        }
      />
    </div>
  );
}
