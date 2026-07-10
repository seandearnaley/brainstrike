import type {
  CreatePromptItemInput,
  PromptItem,
  PromptItemFilter,
  PromptItemKind,
  PromptItemRepository,
  PromptItemSimilarityResult,
  PromptItemUsageAction,
  UpdatePromptItemInput,
} from '@brainstrike/db';
import {
  Badge,
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
  Braces,
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

export type PromptWorkbenchRepository = Pick<
  PromptItemRepository,
  'create' | 'list' | 'recordUsage' | 'update'
>;

export interface PromptWorkbenchModelOption {
  readonly key: string;
  readonly label: string;
}

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
  readonly systemError?: string;
}

type KindFilter = 'all' | PromptItemKind;

interface PendingUse {
  readonly action: PromptItemUsageAction;
  readonly item: PromptItem;
}

interface PromptDraft {
  content: string;
  description: string;
  isFavorite: boolean;
  kind: PromptItemKind;
  modelKey: string;
  sourceUrl: string;
  tags: string;
  title: string;
}

const PROMPT_KINDS: readonly PromptItemKind[] = ['fragment', 'snippet', 'prompt'];

const KIND_COPY: Record<PromptItemKind, { label: string; short: string }> = {
  fragment: { label: 'Idea fragment', short: 'Fragment' },
  prompt: { label: 'Runnable prompt', short: 'Prompt' },
  snippet: { label: 'Reusable snippet', short: 'Snippet' },
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected prompt workbench failure: ${String(error)}`;
}

function toDraft(item: PromptItem | null): PromptDraft {
  return item
    ? {
        content: item.content,
        description: item.description ?? '',
        isFavorite: item.isFavorite,
        kind: item.kind,
        modelKey: item.modelKey ?? '',
        sourceUrl: item.sourceUrl ?? '',
        tags: item.tags.join(', '),
        title: item.title,
      }
    : {
        content: '',
        description: '',
        isFavorite: false,
        kind: 'prompt',
        modelKey: '',
        sourceUrl: '',
        tags: '',
        title: '',
      };
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
  onRequestSuggestions,
  refreshKey,
}: {
  readonly composerContext: string;
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
    if (!context) {
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
  }, [context, onRequestSuggestions, refreshKey]);

  if (!context) {
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
        kind === 'prompt' && 'border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-300',
        kind === 'snippet' &&
          'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        kind === 'fragment' &&
          'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
  );
}

function EmbeddingState({ item }: { readonly item: PromptItem }) {
  if (item.embeddingStatus === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-300">
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

function PromptBuilderDialog({
  item,
  modelOptions,
  onClose,
  onSave,
}: {
  readonly item: PromptItem | null;
  readonly modelOptions: readonly PromptWorkbenchModelOption[];
  readonly onClose: () => void;
  readonly onSave: (draft: PromptDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PromptDraft>(() => toDraft(item));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const variables = useMemo(() => extractPromptTemplateVariables(draft.content), [draft.content]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave(draft);
      setSaving(false);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[min(90vh,780px)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 text-sky-600 dark:text-sky-300">
            <WandSparkles aria-hidden="true" className="size-4" />
            <span className="font-medium text-[11px] uppercase tracking-[0.16em]">
              Prompt builder
            </span>
          </div>
          <DialogTitle>{item ? `Edit ${item.title}` : 'Build a prompt'}</DialogTitle>
          <DialogDescription>
            Keep the intent separate from the reusable instruction. Variables use{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">{'{{name}}'}</code>.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-title">Title</Label>
              <Input
                autoFocus
                id="prompt-builder-title"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
                placeholder="e.g. Adversarial code review"
                value={draft.title}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-kind">Type</Label>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="prompt-builder-kind"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    kind: event.target.value as PromptItemKind,
                  }))
                }
                value={draft.kind}
              >
                {PROMPT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_COPY[kind].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="prompt-builder-intention">Intention</Label>
            <Input
              id="prompt-builder-intention"
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="What job should this do, and when should it be recalled?"
              value={draft.description}
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="prompt-builder-content">Prompt text</Label>
              <span className="text-[10px] text-muted-foreground">
                {draft.content.length.toLocaleString()} characters
              </span>
            </div>
            <textarea
              className="min-h-48 w-full resize-y rounded-lg border border-input bg-background/80 px-3 py-3 font-mono text-[13px] leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              id="prompt-builder-content"
              onChange={(event) =>
                setDraft((current) => ({ ...current, content: event.target.value }))
              }
              placeholder="Write the reusable instruction…"
              required
              value={draft.content}
            />
            {variables.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-testid="prompt-builder-variables"
              >
                <Braces aria-hidden="true" className="size-3.5 text-sky-500" />
                {variables.map((variable) => (
                  <Badge className="font-mono font-normal" key={variable} variant="outline">
                    {variable}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-tags">Recall tags</Label>
              <Input
                id="prompt-builder-tags"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, tags: event.target.value }))
                }
                placeholder="review, evidence, security"
                value={draft.tags}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-model">Run with</Label>
              <select
                aria-label="Run with"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="prompt-builder-model"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, modelKey: event.target.value }))
                }
                value={draft.modelKey}
              >
                <option value="">Current thread model</option>
                {modelOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-builder-source">Source URL</Label>
              <Input
                id="prompt-builder-source"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, sourceUrl: event.target.value }))
                }
                placeholder="Optional provenance"
                type="url"
                value={draft.sourceUrl}
              />
            </div>
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm">
              <input
                checked={draft.isFavorite}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, isFavorite: event.target.checked }))
                }
                type="checkbox"
              />
              <Star aria-hidden="true" className="size-3.5" /> Favorite
            </label>
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={saving || !draft.content.trim()} type="submit">
              {saving ? 'Saving…' : item ? 'Save changes' : 'Save prompt'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setWorking(true);
    try {
      await onPrepared(renderPromptTemplate(pendingUse.item.content, values));
      setWorking(false);
      onClose();
    } catch (cause) {
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
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
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
  onInsert,
  suggestions,
}: {
  readonly activeThreadId: string | undefined;
  readonly onInsert: (item: PromptItem) => void;
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
            return (
              <div
                className="min-w-48 flex-1 rounded-lg border border-sky-500/20 bg-background/90 p-2 shadow-xs"
                data-testid={`prompt-context-suggestion-${suggestion.id}`}
                key={suggestion.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-[11px]">{suggestion.title}</span>
                  <span className="shrink-0 font-mono text-[9px] text-sky-600 dark:text-sky-300">
                    {Math.round(suggestion.similarity * 100)}% match
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground leading-4">
                  {suggestion.content}
                </p>
                <Button
                  aria-label="Insert suggestion"
                  className="mt-1.5 h-6 px-1.5 text-[10px]"
                  disabled={!activeThreadId}
                  onClick={() => onInsert(suggestedItem)}
                  size="xs"
                  variant="ghost"
                >
                  <MessageSquarePlus aria-hidden="true" /> Insert
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
          <div className="flex items-center gap-1.5 text-sky-600 dark:text-sky-300">
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
          className="min-h-20 w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
          onChange={(event) => onCaptureChange(event.target.value)}
          onKeyDown={onCaptureKeyDown}
          placeholder="Drop a phrase, constraint, example, or half-formed idea…"
          value={capture}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2 border-border/60 border-t pt-2">
          <fieldset className="m-0 flex min-w-0 gap-0.5 border-0 p-0">
            <legend className="sr-only">Capture type</legend>
            {PROMPT_KINDS.map((option) => (
              <button
                aria-pressed={kind === option}
                className={cn(
                  'rounded-md px-1.5 py-1 font-medium text-[10px] transition-colors',
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
            className="h-7 rounded-full px-2.5 text-[10px]"
            disabled={!capture.trim() || capturing}
            onClick={onCapture}
            size="xs"
          >
            <Zap aria-hidden="true" />
            {capturing ? 'Filing…' : 'File clip'}
            <kbd className="hidden rounded border border-primary-foreground/20 px-1 font-sans text-[9px] opacity-70 xl:inline">
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
          className={cn('rounded-full', favoriteOnly && 'text-amber-500')}
          onClick={() => onFavoriteOnlyChange(!favoriteOnly)}
          size="icon-sm"
          variant="ghost"
        >
          <Star aria-hidden="true" className={cn(favoriteOnly && 'fill-current')} />
        </Button>
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-border/60 border-b px-3 py-1.5">
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
  items,
  onEdit,
  onUse,
}: {
  readonly activeThreadId: string | undefined;
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
                        <Star
                          aria-label="Favorite"
                          className="size-3 fill-amber-400 text-amber-500"
                        />
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
                    disabled={!activeThreadId}
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
  const [suggestionRefreshKey, setSuggestionRefreshKey] = useState(0);
  const suggestions = useContextualPromptSuggestions({
    composerContext,
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

  const requestUse = useCallback(
    (item: PromptItem, action: PromptItemUsageAction) => {
      if (extractPromptTemplateVariables(item.content).length > 0) {
        setPendingUse({ action, item });
        return;
      }
      void completeUse(item, item.content, action).catch(() => {
        // completeUse owns the visible primary-action error for fire-and-forget actions.
      });
    },
    [completeUse]
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
        modelSettings: null,
        rating: null,
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
          } satisfies UpdatePromptItemInput)
        : await repository.create(common);
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
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
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
          onInsert={(item) => requestUse(item, resolveItemUseAction(item))}
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
          onPrepared={(content) => completeUse(pendingUse.item, content, pendingUse.action)}
          pendingUse={pendingUse}
        />
      ) : null}
    </section>
  );
}
