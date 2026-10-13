import type {
  CreatePromptItemInput,
  PromptItem,
  PromptItemFilter,
  PromptItemKind,
  PromptItemSimilarityResult,
  PromptItemUsageAction,
  UpdatePromptItemInput,
} from '@brainstrike/db';
import type { PromptItemRepositoryPort } from '@brainstrike/types/prompt-item';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import {
  ArrowUpRight,
  BookOpenText,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  Filter,
  Lightbulb,
  MessageSquarePlus,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Star,
  WandSparkles,
  Zap,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { extractPromptTemplateVariables, renderPromptTemplate } from './prompt-template';
import { PromptBuilderDialog } from './prompt-workbench-builder-dialog';
import {
  buildPromptModelSettings,
  promptWorkbenchErrorMessage as errorMessage,
  KIND_COPY,
  PROMPT_KINDS,
  type PromptDraft,
  type PromptWorkbenchModelOption,
} from './prompt-workbench-shared';

export type PromptWorkbenchRepository = Pick<
  PromptItemRepositoryPort,
  'create' | 'list' | 'recordUsage' | 'update'
>;

export type { PromptWorkbenchModelOption } from './prompt-workbench-shared';

export interface PromptWorkbenchPanelProps {
  readonly activeThreadId?: string;
  readonly composerContext: string;
  readonly initialItems: readonly PromptItem[];
  readonly modelOptions: readonly PromptWorkbenchModelOption[];
  readonly onLibraryChanged: () => Promise<void>;
  readonly onRequestSuggestions: (
    context: string
  ) => Promise<readonly PromptItemSimilarityResult[]>;
  readonly onUseItem: (
    item: PromptItem,
    renderedContent: string,
    action: PromptItemUsageAction
  ) => Promise<void>;
  readonly repository: PromptWorkbenchRepository;
  readonly suggestionsEnabled?: boolean;
  readonly systemError?: string;
}

type KindFilter = 'all' | PromptItemKind;

interface PendingUse {
  readonly action: PromptItemUsageAction;
  readonly item: PromptItem;
}

function tagsFromDraft(tags: string): string[] {
  const result: string[] = [];
  for (const tag of tags.split(',')) {
    const normalized = tag.trim();
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function resolveItemUseAction(item: PromptItem): PromptItemUsageAction {
  return item.kind === 'prompt' ? 'compose' : 'insert';
}

function actionLabel(item: PromptItem): string {
  return item.kind === 'prompt' ? `Compose ${item.title}` : `Insert ${item.title}`;
}

function directUseKey(item: PromptItem, action: PromptItemUsageAction): string {
  return JSON.stringify([item.id, action]);
}

function itemMatches(item: PromptItem, search: string, kind: KindFilter): boolean {
  if (kind !== 'all' && item.kind !== kind) {
    return false;
  }
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [item.title, item.content, item.description ?? '', ...item.tags]
    .join('\n')
    .toLocaleLowerCase()
    .includes(needle);
}

function promptItemWithoutSimilarity(result: PromptItemSimilarityResult): PromptItem {
  const { similarity: _similarity, ...item } = result;
  return item;
}

function usePromptLibraryItems(
  repository: PromptWorkbenchRepository,
  initialItems: readonly PromptItem[]
) {
  const [snapshot, setSnapshot] = useState<{
    readonly items: PromptItem[];
    readonly source: readonly PromptItem[];
  }>(() => ({ items: [...initialItems], source: initialItems }));
  const latestInitialItemsRef = useRef(initialItems);
  useLayoutEffect(() => {
    latestInitialItemsRef.current = initialItems;
  }, [initialItems]);
  const items = snapshot.source === initialItems ? snapshot.items : [...initialItems];

  const refresh = useCallback(async () => {
    const refreshedItems = await repository.list({} satisfies PromptItemFilter);
    setSnapshot(() => ({ items: refreshedItems, source: latestInitialItemsRef.current }));
  }, [repository]);

  const updateItems = useCallback((update: (items: PromptItem[]) => PromptItem[]) => {
    setSnapshot((current) => {
      const latestInitialItems = latestInitialItemsRef.current;
      const currentItems =
        current.source === latestInitialItems ? current.items : [...latestInitialItems];
      return { items: update(currentItems), source: latestInitialItems };
    });
  }, []);

  return { items, refresh, updateItems };
}

interface PromptSuggestionState {
  readonly context: string;
  readonly error: string | null;
  readonly refreshKey: number;
  readonly results: PromptItemSimilarityResult[];
  readonly status: 'error' | 'ready';
}

function useContextualPromptSuggestions({
  composerContext,
  enabled,
  onRequestSuggestions,
  refreshKey,
}: {
  readonly composerContext: string;
  readonly enabled: boolean;
  readonly onRequestSuggestions: PromptWorkbenchPanelProps['onRequestSuggestions'];
  readonly refreshKey: number;
}) {
  const context = composerContext.trim();
  const [snapshot, setSnapshot] = useState<PromptSuggestionState>({
    context: '',
    error: null,
    refreshKey: -1,
    results: [],
    status: 'ready',
  });

  useEffect(() => {
    if (!(enabled && context)) {
      return;
    }
    let current = true;
    const timeout = setTimeout(() => {
      void onRequestSuggestions(context)
        .then((results) => {
          if (current) {
            setSnapshot({
              context,
              error: null,
              refreshKey,
              results: [...results],
              status: 'ready',
            });
          }
        })
        .catch((cause) => {
          if (current) {
            setSnapshot({
              context,
              error: errorMessage(cause),
              refreshKey,
              results: [],
              status: 'error',
            });
          }
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [context, enabled, onRequestSuggestions, refreshKey]);

  if (!(enabled && context)) {
    return { error: null, results: [], status: 'idle' as const };
  }
  if (snapshot.context !== context || snapshot.refreshKey !== refreshKey) {
    return { error: null, results: [], status: 'loading' as const };
  }
  return { error: snapshot.error, results: snapshot.results, status: snapshot.status };
}

function PromptKindMark({ kind }: { readonly kind: PromptItemKind }) {
  const Icon = kind === 'prompt' ? BookOpenText : kind === 'snippet' ? FileText : Lightbulb;
  return (
    <span
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-lg border',
        kind === 'prompt' && 'border-sky-500/25 bg-sky-500/10 text-sky-800 dark:text-sky-300',
        kind === 'snippet' &&
          'border-amber-500/25 bg-amber-500/10 text-orange-800 dark:text-orange-300',
        kind === 'fragment' &&
          'border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
  );
}

function EmbeddingState({ item }: { readonly item: PromptItem }) {
  if (item.embeddingStatus === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-success">
        <Check aria-hidden="true" className="size-2.5" /> Indexed
      </span>
    );
  }
  if (item.embeddingStatus === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-destructive"
        title={item.embeddingError ?? undefined}
      >
        <CircleAlert aria-hidden="true" className="size-2.5" /> Index failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <Clock3 aria-hidden="true" className="size-2.5" /> Indexing
    </span>
  );
}

function PreparePromptDialog({
  pendingUse,
  onClose,
  onPrepared,
}: {
  readonly pendingUse: PendingUse;
  readonly onClose: () => void;
  readonly onPrepared: (content: string) => Promise<void>;
}) {
  const variables = useMemo(
    () => extractPromptTemplateVariables(pendingUse.item.content),
    [pendingUse.item.content]
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setWorking(true);
    try {
      await onPrepared(renderPromptTemplate(pendingUse.item.content, values));
      if (!mountedRef.current) {
        return;
      }
      setWorking(false);
      onClose();
    } catch (cause) {
      if (!mountedRef.current) {
        return;
      }
      setError(errorMessage(cause));
      setWorking(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Prepare ${pendingUse.item.title}`}</DialogTitle>
          <DialogDescription>
            Fill the reusable variables. Nothing is sent until you review the composer.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          {variables.map((variable) => (
            <div className="grid gap-1.5" key={variable}>
              <Label htmlFor={`prompt-variable-${variable}`}>{variable}</Label>
              <Input
                aria-label={variable}
                id={`prompt-variable-${variable}`}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [variable]: event.target.value }))
                }
                required
                value={values[variable] ?? ''}
              />
            </div>
          ))}
          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={working} type="submit">
              {pendingUse.action === 'new-thread' ? 'Start new thread' : 'Add to composer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ContextualRecall({
  activeThreadId,
  isUsePending,
  onUse,
  suggestions,
}: {
  readonly activeThreadId: string | undefined;
  readonly isUsePending: (item: PromptItem, action: PromptItemUsageAction) => boolean;
  readonly onUse: (item: PromptItem, action: PromptItemUsageAction) => void;
  readonly suggestions: ReturnType<typeof useContextualPromptSuggestions>;
}) {
  return (
    <div className="border-border/70 border-b bg-muted/20 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <WandSparkles aria-hidden="true" className="size-3.5 text-sky-500" />
          <span className="font-semibold text-[10px] uppercase tracking-[0.12em]">
            Contextual recall
          </span>
        </div>
        {suggestions.status === 'loading' ? (
          <span className="text-[10px] text-muted-foreground">Reading draft…</span>
        ) : null}
      </div>
      {suggestions.status === 'error' ? (
        <p className="mt-1.5 text-[10px] text-destructive" role="alert">
          Vector recall unavailable: {suggestions.error}
        </p>
      ) : null}
      {suggestions.status === 'ready' && suggestions.results.length === 0 ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          No indexed clips match this draft yet.
        </p>
      ) : null}
      {suggestions.results.length > 0 ? (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">
          {suggestions.results.slice(0, 4).map((suggestion) => {
            const suggestedItem = promptItemWithoutSimilarity(suggestion);
            const action = resolveItemUseAction(suggestedItem);
            const verb = action === 'compose' ? 'Compose' : 'Insert';
            return (
              <div
                className="w-full @[260px]/prompt-workbench:min-w-48 min-w-0 @[260px]/prompt-workbench:flex-1 flex-none rounded-lg border border-sky-500/20 bg-background/90 p-2 shadow-xs"
                data-testid={`prompt-context-suggestion-${suggestion.id}`}
                key={suggestion.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-[11px]">{suggestion.title}</span>
                  <span className="shrink-0 font-mono text-[9px] text-info">
                    {Math.round(suggestion.similarity * 100)}% match
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground leading-4">
                  {suggestion.content}
                </p>
                <Button
                  aria-label={`${verb} ${suggestion.title}`}
                  className="mt-1.5 h-6 px-1.5 text-[10px]"
                  disabled={!activeThreadId || isUsePending(suggestedItem, action)}
                  onClick={() => onUse(suggestedItem, action)}
                  size="xs"
                  variant="ghost"
                >
                  <MessageSquarePlus aria-hidden="true" /> {verb}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function QuickCapture({
  capture,
  capturing,
  kind,
  onBuildPrompt,
  onCapture,
  onCaptureChange,
  onCaptureKeyDown,
  onKindChange,
}: {
  readonly capture: string;
  readonly capturing: boolean;
  readonly kind: PromptItemKind;
  readonly onBuildPrompt: () => void;
  readonly onCapture: () => void;
  readonly onCaptureChange: (value: string) => void;
  readonly onCaptureKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onKindChange: (kind: PromptItemKind) => void;
}) {
  return (
    <div className="border-border/80 border-b px-3 pt-3 pb-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-info">
            <Sparkles aria-hidden="true" className="size-3.5" />
            <span className="font-semibold text-[10px] uppercase tracking-[0.17em]">
              Prompt workbench
            </span>
          </div>
          <h2 className="mt-1 font-semibold text-sm tracking-tight">Capture now. Shape later.</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Your working library, recalled against the live draft.
          </p>
        </div>
        <Button
          aria-label="Build a prompt"
          className="rounded-full"
          onClick={onBuildPrompt}
          size="icon-sm"
          variant="outline"
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-3 rounded-xl border border-border/80 bg-background/80 p-2 shadow-sm backdrop-blur-sm">
        <textarea
          aria-label="Quick capture"
          className="min-h-20 w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
          onChange={(event) => onCaptureChange(event.target.value)}
          onKeyDown={onCaptureKeyDown}
          placeholder="Drop a phrase, constraint, example, or half-formed idea…"
          value={capture}
        />
        <div
          className="mt-1.5 flex @[260px]/prompt-workbench:flex-row flex-col @[260px]/prompt-workbench:items-center items-stretch @[260px]/prompt-workbench:justify-between gap-2 border-border/60 border-t pt-2"
          data-testid="quick-capture-actions"
        >
          <fieldset className="m-0 @[260px]/prompt-workbench:flex grid min-w-0 grid-cols-3 gap-0.5 border-0 p-0">
            <legend className="sr-only">Capture type</legend>
            {PROMPT_KINDS.map((option) => (
              <button
                aria-pressed={kind === option}
                className={cn(
                  'min-w-0 rounded-md @[260px]/prompt-workbench:px-1.5 px-0.5 py-1 font-medium @[260px]/prompt-workbench:text-[10px] text-[9px] transition-colors',
                  kind === option
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                key={option}
                onClick={() => onKindChange(option)}
                type="button"
              >
                {KIND_COPY[option].short}
              </button>
            ))}
          </fieldset>
          <Button
            aria-label={capturing ? 'Filing clip' : 'File clip'}
            className="h-7 @[260px]/prompt-workbench:w-auto w-full justify-center rounded-full px-2.5 text-[10px]"
            disabled={!capture.trim() || capturing}
            onClick={onCapture}
            size="xs"
          >
            <Zap aria-hidden="true" />
            {capturing ? 'Filing…' : 'File clip'}
            <kbd className="@[340px]/prompt-workbench:inline hidden rounded border border-primary-foreground/20 px-1 font-sans text-[9px] opacity-70">
              ⌘↵
            </kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

function PromptLibraryControls({
  favoriteOnly,
  itemCount,
  kindFilter,
  onFavoriteOnlyChange,
  onKindFilterChange,
  onSearchChange,
  search,
}: {
  readonly favoriteOnly: boolean;
  readonly itemCount: number;
  readonly kindFilter: KindFilter;
  readonly onFavoriteOnlyChange: (favoriteOnly: boolean) => void;
  readonly onKindFilterChange: (kind: KindFilter) => void;
  readonly onSearchChange: (search: string) => void;
  readonly search: string;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5 border-border/70 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search prompt library"
            className="h-8 rounded-full pl-8 text-xs shadow-none"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search intent, text, tags…"
            value={search}
          />
        </div>
        <Button
          aria-label="Favorites only"
          aria-pressed={favoriteOnly}
          className={cn('rounded-full', favoriteOnly && 'text-warning')}
          onClick={() => onFavoriteOnlyChange(!favoriteOnly)}
          size="icon-sm"
          variant="ghost"
        >
          <Star aria-hidden="true" className={cn(favoriteOnly && 'fill-current')} />
        </Button>
      </div>
      <div
        className="flex flex-wrap items-center gap-x-1 gap-y-1 border-border/60 border-b px-3 py-1.5"
        data-testid="prompt-kind-filters"
      >
        <Filter aria-hidden="true" className="mr-0.5 size-3 text-muted-foreground" />
        {(['all', ...PROMPT_KINDS] as const).map((option) => (
          <button
            aria-pressed={kindFilter === option}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
              kindFilter === option
                ? 'border-foreground/20 bg-foreground text-background'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
            )}
            key={option}
            onClick={() => onKindFilterChange(option)}
            type="button"
          >
            {option === 'all' ? `All · ${itemCount}` : KIND_COPY[option].short}
          </button>
        ))}
      </div>
    </>
  );
}

function PromptLibraryList({
  activeThreadId,
  isUsePending,
  items,
  onEdit,
  onUse,
}: {
  readonly activeThreadId: string | undefined;
  readonly isUsePending: (item: PromptItem, action: PromptItemUsageAction) => boolean;
  readonly items: readonly PromptItem[];
  readonly onEdit: (item: PromptItem) => void;
  readonly onUse: (item: PromptItem, action: PromptItemUsageAction) => void;
}) {
  return (
    <>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
        data-testid="prompt-library-scroll"
      >
        <div className="w-full min-w-0 overflow-hidden p-2">
          {items.length === 0 ? (
            <div className="grid place-items-center px-6 py-12 text-center">
              <Lightbulb aria-hidden="true" className="size-7 text-muted-foreground/50" />
              <p className="mt-2 font-medium text-xs">No clips in this view</p>
              <p className="mt-1 max-w-52 text-[10px] text-muted-foreground leading-4">
                Capture a thought above. You can turn it into a structured prompt whenever it earns
                the effort.
              </p>
            </div>
          ) : null}
          <ul className="m-0 grid w-full min-w-0 list-none gap-1 p-0">
            {items.map((item) => (
              <li
                className="group min-w-0 overflow-hidden rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-border/70 hover:bg-muted/35"
                key={item.id}
              >
                <div className="flex items-start gap-2">
                  <PromptKindMark kind={item.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate font-medium text-[12px]">{item.title}</h3>
                      {item.isFavorite ? (
                        <Star aria-label="Favorite" className="size-3 fill-warning text-warning" />
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground leading-4">
                      {item.description || item.content}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <EmbeddingState item={item} />
                      {item.tags.slice(0, 2).map((tag) => (
                        <span className="text-[9px] text-muted-foreground" key={tag}>
                          #{tag}
                        </span>
                      ))}
                      {item.useCount > 0 ? (
                        <span className="text-[9px] text-muted-foreground">
                          used {item.useCount}×
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-end gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
                  <Button
                    aria-label={`Edit ${item.title}`}
                    onClick={() => onEdit(item)}
                    size="icon-xs"
                    title="Edit"
                    variant="ghost"
                  >
                    <PencilLine aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={`New thread from ${item.title}`}
                    disabled={isUsePending(item, 'new-thread')}
                    onClick={() => onUse(item, 'new-thread')}
                    size="icon-xs"
                    title="Start new thread"
                    variant="ghost"
                  >
                    <ArrowUpRight aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={actionLabel(item)}
                    className="h-7 px-2 text-[10px]"
                    disabled={!activeThreadId || isUsePending(item, resolveItemUseAction(item))}
                    onClick={() => onUse(item, resolveItemUseAction(item))}
                    size="xs"
                    title={activeThreadId ? undefined : 'Open a thread to use this clip'}
                    variant="secondary"
                  >
                    <MessageSquarePlus aria-hidden="true" />
                    {item.kind === 'prompt' ? 'Compose' : 'Insert'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <footer className="flex items-center justify-between gap-2 border-border/70 border-t bg-muted/15 px-3 py-1.5 text-[9px] text-muted-foreground">
        <span>{items.length} visible</span>
        <span className="truncate">
          {activeThreadId ? 'Actions stage in the composer' : 'Open a thread to compose'}
        </span>
      </footer>
    </>
  );
}

export function PromptWorkbenchPanel({
  activeThreadId,
  composerContext,
  initialItems,
  modelOptions,
  onLibraryChanged,
  onRequestSuggestions,
  onUseItem,
  repository,
  suggestionsEnabled = true,
  systemError,
}: PromptWorkbenchPanelProps) {
  const {
    items,
    refresh: refreshItems,
    updateItems,
  } = usePromptLibraryItems(repository, initialItems);
  const [actionError, setActionError] = useState<string | null>(null);
  const [libraryWarning, setLibraryWarning] = useState<string | null>(null);
  const [capture, setCapture] = useState('');
  const [captureKind, setCaptureKind] = useState<PromptItemKind>('fragment');
  const [capturing, setCapturing] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [builderItem, setBuilderItem] = useState<PromptItem | null | undefined>();
  const [pendingUse, setPendingUse] = useState<PendingUse | null>(null);
  const directUseKeysRef = useRef<Set<string> | null>(null);
  if (directUseKeysRef.current === null) {
    directUseKeysRef.current = new Set<string>();
  }
  const directUseGuard = directUseKeysRef.current;
  const preparedUsePromisesRef = useRef<Map<string, Promise<void>> | null>(null);
  if (preparedUsePromisesRef.current === null) {
    preparedUsePromisesRef.current = new Map<string, Promise<void>>();
  }
  const preparedUsePromises = preparedUsePromisesRef.current;
  const [directUseKeys, setDirectUseKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [suggestionRefreshKey, setSuggestionRefreshKey] = useState(0);
  const suggestions = useContextualPromptSuggestions({
    composerContext,
    enabled: suggestionsEnabled,
    onRequestSuggestions,
    refreshKey: suggestionRefreshKey,
  });

  const filteredItems = useMemo(
    () =>
      items.filter(
        (item) => itemMatches(item, search, kindFilter) && (!favoriteOnly || item.isFavorite)
      ),
    [favoriteOnly, items, kindFilter, search]
  );

  const notifyLibraryChanged = useCallback(async () => {
    const warnings: string[] = [];
    try {
      await onLibraryChanged();
    } catch (cause) {
      warnings.push(`Prompt saved, but indexing failed: ${errorMessage(cause)}`);
    }
    try {
      await refreshItems();
    } catch (cause) {
      warnings.push(`Prompt saved, but the library could not refresh: ${errorMessage(cause)}`);
    }
    setLibraryWarning(warnings.length > 0 ? warnings.join(' ') : null);
    setSuggestionRefreshKey((current) => current + 1);
  }, [onLibraryChanged, refreshItems]);

  const captureClip = useCallback(async () => {
    if (!capture.trim() || capturing) {
      return;
    }
    setCapturing(true);
    setActionError(null);
    try {
      const created = await repository.create({ content: capture, kind: captureKind });
      updateItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setCapture('');
      await notifyLibraryChanged();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
    setCapturing(false);
  }, [capture, captureKind, capturing, notifyLibraryChanged, repository, updateItems]);

  const handleCaptureKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void captureClip();
    }
  };

  const completeUse = useCallback(
    async (item: PromptItem, content: string, action: PromptItemUsageAction) => {
      setActionError(null);
      try {
        await onUseItem(item, content, action);
      } catch (cause) {
        const message = errorMessage(cause);
        setActionError(message);
        throw cause instanceof Error ? cause : new Error(message);
      }
      try {
        await refreshItems();
      } catch (cause) {
        setLibraryWarning(
          `Prompt action completed, but the library could not refresh: ${errorMessage(cause)}`
        );
        return;
      }
      setLibraryWarning(null);
    },
    [onUseItem, refreshItems]
  );

  const completePreparedUse = useCallback(
    (item: PromptItem, content: string, action: PromptItemUsageAction): Promise<void> => {
      const key = directUseKey(item, action);
      const activeSubmission = preparedUsePromises.get(key);
      if (activeSubmission) {
        return activeSubmission;
      }

      let trackedSubmission: Promise<void>;
      trackedSubmission = completeUse(item, content, action).finally(() => {
        if (preparedUsePromises.get(key) === trackedSubmission) {
          preparedUsePromises.delete(key);
        }
      });
      preparedUsePromises.set(key, trackedSubmission);
      return trackedSubmission;
    },
    [completeUse, preparedUsePromises]
  );

  const requestUse = useCallback(
    (item: PromptItem, action: PromptItemUsageAction) => {
      if (extractPromptTemplateVariables(item.content).length > 0) {
        setPendingUse({ action, item });
        return;
      }

      const key = directUseKey(item, action);
      if (directUseGuard.has(key)) {
        return;
      }
      directUseGuard.add(key);
      setDirectUseKeys(new Set(directUseGuard));
      void completeUse(item, item.content, action)
        .catch(() => {
          // completeUse owns the visible primary-action error for fire-and-forget actions.
        })
        .finally(() => {
          directUseGuard.delete(key);
          setDirectUseKeys(new Set(directUseGuard));
        });
    },
    [completeUse, directUseGuard]
  );

  const isUsePending = useCallback(
    (item: PromptItem, action: PromptItemUsageAction) =>
      directUseKeys.has(directUseKey(item, action)),
    [directUseKeys]
  );

  const saveBuilder = useCallback(
    async (draft: PromptDraft) => {
      setActionError(null);
      const common = {
        content: draft.content,
        description: draft.description || null,
        isFavorite: draft.isFavorite,
        kind: draft.kind,
        modelKey: draft.modelKey || null,
        modelSettings: buildPromptModelSettings(draft.modelSettings, builderItem?.modelSettings),
        sourceUrl: draft.sourceUrl || null,
        tags: tagsFromDraft(draft.tags),
        title: draft.title,
      } satisfies CreatePromptItemInput;

      const saved = builderItem
        ? await repository.update({
            ...common,
            expectedRevision: builderItem.revision,
            id: builderItem.id,
            note: 'Edited in Prompt Workbench',
            rating: builderItem.rating,
          } satisfies UpdatePromptItemInput)
        : await repository.create({ ...common, rating: null });
      updateItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      await notifyLibraryChanged();
    },
    [builderItem, notifyLibraryChanged, repository, updateItems]
  );
  const visibleError = [actionError, libraryWarning, systemError]
    .filter((error): error is string => Boolean(error))
    .join('\n');

  return (
    <section
      aria-label="Prompt workbench"
      className="@container/prompt-workbench flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="prompt-workbench"
    >
      <QuickCapture
        capture={capture}
        capturing={capturing}
        kind={captureKind}
        onBuildPrompt={() => setBuilderItem(null)}
        onCapture={() => void captureClip()}
        onCaptureChange={setCapture}
        onCaptureKeyDown={handleCaptureKeyDown}
        onKindChange={setCaptureKind}
      />

      {composerContext.trim() ? (
        <ContextualRecall
          activeThreadId={activeThreadId}
          isUsePending={isUsePending}
          onUse={requestUse}
          suggestions={suggestions}
        />
      ) : null}

      <PromptLibraryControls
        favoriteOnly={favoriteOnly}
        itemCount={items.length}
        kindFilter={kindFilter}
        onFavoriteOnlyChange={setFavoriteOnly}
        onKindFilterChange={setKindFilter}
        onSearchChange={setSearch}
        search={search}
      />

      {visibleError ? (
        <div
          className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"
          role="alert"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{visibleError}</span>
        </div>
      ) : null}

      <PromptLibraryList
        activeThreadId={activeThreadId}
        isUsePending={isUsePending}
        items={filteredItems}
        onEdit={setBuilderItem}
        onUse={requestUse}
      />

      {builderItem === undefined ? null : (
        <PromptBuilderDialog
          item={builderItem}
          key={builderItem?.id ?? 'new-prompt'}
          modelOptions={modelOptions}
          onClose={() => setBuilderItem(undefined)}
          onSave={saveBuilder}
        />
      )}

      {pendingUse ? (
        <PreparePromptDialog
          onClose={() => setPendingUse(null)}
          onPrepared={(content) => completePreparedUse(pendingUse.item, content, pendingUse.action)}
          pendingUse={pendingUse}
        />
      ) : null}
    </section>
  );
}
