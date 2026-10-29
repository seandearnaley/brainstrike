import { useIndexConfigStore } from '@brainstrike/app-state/stores/index-config-store';
import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_TOKENS,
  INDEX_CHUNKING_OFF_MESSAGE,
  INDEX_CONFIG_UNREADABLE,
  type IndexChunking,
  type IndexConfig,
  type IndexConfigPatch,
  type IndexModel,
  sameIndexChunking,
  sameIndexModel,
} from '@brainstrike/assistant-contract/index-config';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import {
  BACKGROUND_INDEXING_POLICY_OPTIONS,
  type BackgroundIndexingPolicyPreset,
  getBackgroundIndexingPolicyOption,
} from '@brainstrike/utils';
import { startTransition, useActionState, useState } from 'react';
import { SearchIndexModelCard } from './search-index-model-card';
import { SearchIndexStatus } from './search-index-status';

const MODES = [
  {
    description: 'No index. Explorer search and semantic tools are unavailable.',
    label: 'Off',
    mode: 'off',
  },
  {
    description: 'Fast keyword search. No model.',
    label: 'Text',
    mode: 'text',
  },
  {
    description: 'Keyword plus meaning. Embeds every chunk with a model.',
    label: 'Semantic',
    mode: 'semantic',
  },
] as const;
const AUTO_SIZES = [
  ['TypeScript · JS', '512 / 64'],
  ['Python', '512 / 50'],
  ['Go · Java · C++', '640 / 72'],
  ['Rust', '768 / 75'],
  ['Other code', '384 / 48'],
  ['Prose · Markdown', '500 / 50'],
  ['JSON · XML · CSV · SQL · logs', '1500 / 150'],
] as const;
const FIRST_CUSTOM: IndexChunking = { _tag: 'Custom', maxTokens: 512, overlap: 64 };
const UNAVAILABLE = 'Search index settings are unavailable in this window.';

/** Choices that re-index every file, held here until the user applies them. */
type Staged = Pick<IndexConfigPatch, 'chunking' | 'mode' | 'model'>;
type CustomChunking = Extract<IndexChunking, { readonly _tag: 'Custom' }>;
interface Bounds {
  readonly maximum: number;
  readonly minimum: number;
}
/** A refused Apply and the staged choices it refused. */
interface Refusal {
  readonly message: string;
  readonly staged: Staged;
}

const inRange = (value: number, bounds: Bounds) =>
  Number.isInteger(value) && value >= bounds.minimum && value <= bounds.maximum;

/** What applying the staged choices will do, one line each. */
function pendingLines(staged: Staged): readonly string[] {
  return [
    ...(staged.mode ? ['Semantic search turns on.'] : []),
    ...(staged.model ? ['Model changes. Vectors for the previous model are removed.'] : []),
    ...(staged.chunking ? ['Chunking changes. Every file is split again.'] : []),
  ];
}

/** Picking the saved model again keeps it. */
function keepsSavedModel(next: IndexModel, saved: IndexModel | null): boolean {
  return saved !== null && sameIndexModel(next, saved);
}

/** Why the staged choices cannot be applied yet; null when they can. */
function applyBlocker(
  staged: Staged,
  mode: IndexConfig['mode'],
  model: IndexModel | null,
  custom: CustomChunking | null
): string | null {
  if (staged.chunking && mode === 'off') {
    return INDEX_CHUNKING_OFF_MESSAGE;
  }
  if (mode === 'semantic' && model === null) {
    return 'Choose an embedding model first.';
  }
  if (
    custom &&
    !(inRange(custom.maxTokens, CHUNK_SIZE_TOKENS) && inRange(custom.overlap, CHUNK_OVERLAP_TOKENS))
  ) {
    return 'Fix the chunk size first.';
  }
  return null;
}

export function SearchIndexSettingsSection({
  nativeIndex,
}: {
  readonly nativeIndex?: Pick<IndexSearchCapability, 'rebuild'>;
} = {}) {
  const view = useIndexConfigStore((store) => store.state);
  const update = useIndexConfigStore((store) => store.update);
  const reset = useIndexConfigStore((store) => store.reset);
  if (view.kind === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading search index settings…
      </p>
    );
  }
  if (view.kind === 'failed') {
    return view.failure.code === INDEX_CONFIG_UNREADABLE && reset ? (
      <UnreadableSettings message={view.message} reset={reset} />
    ) : (
      <p className="text-destructive text-sm" role="alert">
        {view.message}
      </p>
    );
  }
  return <SearchIndexForm config={view.config} nativeIndex={nativeIndex} update={update} />;
}

function SearchIndexForm({
  config,
  nativeIndex,
  update,
}: {
  readonly config: IndexConfig;
  readonly nativeIndex: Pick<IndexSearchCapability, 'rebuild'> | undefined;
  readonly update: ((patch: IndexConfigPatch) => Promise<IndexConfig>) | null;
}) {
  const [staged, setStaged] = useState<Staged>({});
  const [refusal, apply, applying] = useActionState(
    async (_previous: Refusal | null, choices: Staged): Promise<Refusal | null> => {
      if (!update) {
        return { message: UNAVAILABLE, staged: choices };
      }
      try {
        await update(choices);
        setStaged({});
        return null;
      } catch (cause) {
        return { message: describeBoundaryError(cause), staged: choices };
      }
    },
    null
  );
  /** Mode, file policy and pause apply at once, apart from the staged choices. */
  const [changeError, dispatchChange, changing] = useActionState(
    async (_previous: string | null, patch: IndexConfigPatch): Promise<string | null> => {
      if (!update) {
        return UNAVAILABLE;
      }
      try {
        await update(patch);
        return null;
      } catch (cause) {
        return describeBoundaryError(cause);
      }
    },
    null
  );
  const change = (patch: IndexConfigPatch): void => startTransition(() => dispatchChange(patch));
  // A refusal describes the choices it refused; editing or discarding them retires it.
  const applyError = refusal?.staged === staged ? refusal.message : null;
  const busy = applying || changing;

  const mode = staged.mode ?? config.mode;
  const model = staged.model === undefined ? config.model : staged.model;
  const chunking = staged.chunking ?? config.chunking;
  const custom = chunking._tag === 'Custom' ? chunking : null;
  const pending = pendingLines(staged);

  const chooseMode = (next: IndexConfig['mode']): void => {
    if (next === mode) {
      return;
    }
    if (next === 'semantic' && config.model === null) {
      setStaged((current) => ({ ...current, mode: 'semantic' }));
      return;
    }
    if (next !== 'semantic') {
      // Only semantic search uses a model; staged chunking re-indexes in every mode.
      setStaged(({ mode: _mode, model: _model, ...rest }) => rest);
    }
    if (next !== config.mode) {
      change({ mode: next });
    }
  };
  const stageModel = (next: IndexModel): void =>
    setStaged(({ model: _dropped, ...rest }) =>
      keepsSavedModel(next, config.model) ? rest : { ...rest, model: next }
    );
  const stageChunking = (next: IndexChunking): void =>
    setStaged(({ chunking: _dropped, ...rest }) =>
      sameIndexChunking(next, config.chunking) ? rest : { ...rest, chunking: next }
    );

  return (
    <div className="space-y-4 pb-24">
      <SearchIndexStatus
        mode={config.mode}
        onTogglePause={update ? () => change({ paused: !config.paused }) : null}
        paused={config.paused}
      />
      <SearchModeCard applying={busy} mode={mode} onChoose={chooseMode} />
      {mode === 'semantic' ? (
        <SearchIndexModelCard disabled={busy} model={model} onChange={stageModel} />
      ) : null}
      <FoldersCard onPolicy={(policy) => change({ policy })} policy={config.policy} />
      <ChunkingCard
        custom={custom}
        disabled={applying || mode === 'off'}
        offReason={mode === 'off' ? INDEX_CHUNKING_OFF_MESSAGE : null}
        onStage={stageChunking}
      />
      {nativeIndex ? <MaintenanceCard nativeIndex={nativeIndex} /> : null}
      {changeError ? (
        <p className="text-destructive text-sm" role="alert">
          {changeError}
        </p>
      ) : null}
      {pending.length > 0 ? (
        <PendingChanges
          applying={applying}
          blocker={applyBlocker(staged, mode, model, custom)}
          error={applyError}
          lines={pending}
          onApply={() => startTransition(() => apply(staged))}
          onDiscard={() => setStaged({})}
        />
      ) : null}
    </div>
  );
}

function SearchModeCard({
  applying,
  mode,
  onChoose,
}: {
  readonly applying: boolean;
  readonly mode: IndexConfig['mode'];
  readonly onChoose: (mode: IndexConfig['mode']) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Search mode</CardTitle>
        <CardDescription>Applies right away.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset aria-label="Search mode" className="grid min-w-0 gap-2 sm:grid-cols-3">
          {MODES.map((option) => (
            <Button
              aria-pressed={mode === option.mode}
              className="h-auto flex-col items-start gap-1 p-3 text-left whitespace-normal"
              disabled={applying}
              key={option.mode}
              onClick={() => onChoose(option.mode)}
              type="button"
              variant={mode === option.mode ? 'secondary' : 'outline'}
            >
              <span className="font-semibold">{option.label}</span>
              <span className="text-muted-foreground text-xs font-normal">
                {option.description}
              </span>
            </Button>
          ))}
        </fieldset>
      </CardContent>
    </Card>
  );
}

function FoldersCard({
  onPolicy,
  policy,
}: {
  readonly onPolicy: (policy: BackgroundIndexingPolicyPreset) => void;
  readonly policy: BackgroundIndexingPolicyPreset;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Folders</CardTitle>
        <CardDescription>
          Every folder open in the Explorer is indexed. Turn worktrees on in the Worktree map.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="search-index-policy">Files</Label>
        <Select
          onValueChange={(value) => onPolicy(value as BackgroundIndexingPolicyPreset)}
          value={policy}
        >
          <SelectTrigger aria-label="Files" id="search-index-policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BACKGROUND_INDEXING_POLICY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">
          {getBackgroundIndexingPolicyOption(policy).description}
        </p>
        <p className="text-muted-foreground text-sm">
          .gitignore, .llmignore and credential files are always skipped. Files over 500 KB are
          skipped.
        </p>
      </CardContent>
    </Card>
  );
}

function ChunkingCard({
  custom,
  disabled,
  offReason,
  onStage,
}: {
  readonly custom: CustomChunking | null;
  readonly disabled: boolean;
  readonly offReason: string | null;
  readonly onStage: (chunking: IndexChunking) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chunking</CardTitle>
        <CardDescription>Changing it re-indexes every file.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {offReason ? <p className="text-muted-foreground text-sm">{offReason}</p> : null}
        <fieldset aria-label="Chunking" className="flex min-w-0 gap-2">
          <Button
            aria-pressed={custom === null}
            disabled={disabled}
            onClick={() => onStage({ _tag: 'Auto' })}
            size="sm"
            type="button"
            variant={custom === null ? 'secondary' : 'outline'}
          >
            Automatic
          </Button>
          <Button
            aria-pressed={custom !== null}
            disabled={disabled}
            onClick={() => onStage(custom ?? FIRST_CUSTOM)}
            size="sm"
            type="button"
            variant={custom === null ? 'outline' : 'secondary'}
          >
            Custom
          </Button>
        </fieldset>
        {custom === null ? (
          <AutomaticSizes />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <TokenField
              bounds={CHUNK_SIZE_TOKENS}
              disabled={disabled}
              id="search-index-chunk-size"
              label="Chunk size (tokens)"
              onChange={(maxTokens) => onStage({ ...custom, maxTokens })}
              value={custom.maxTokens}
            />
            <TokenField
              bounds={CHUNK_OVERLAP_TOKENS}
              disabled={disabled}
              id="search-index-chunk-overlap"
              label="Overlap (tokens)"
              onChange={(overlap) => onStage({ ...custom, overlap })}
              value={custom.overlap}
            />
            <p className="text-muted-foreground text-sm sm:col-span-2">
              One size for every file type. Splitting still follows code structure and headings.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AutomaticSizes() {
  return (
    <>
      <p className="text-muted-foreground text-sm">
        Code is split along functions and classes, Markdown along headings. Target sizes in tokens,
        with overlap:
      </p>
      <dl className="grid gap-1 text-sm sm:grid-cols-2">
        {AUTO_SIZES.map(([kind, size]) => (
          <div className="flex justify-between gap-3 rounded-md border px-2 py-1" key={kind}>
            <dt>{kind}</dt>
            <dd className="text-muted-foreground font-mono tabular-nums">{size}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function TokenField({
  bounds,
  disabled,
  id,
  label,
  onChange,
  value,
}: {
  readonly bounds: Bounds;
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  const valid = inRange(value, bounds);
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={valid ? undefined : errorId}
        aria-invalid={valid ? undefined : true}
        disabled={disabled}
        id={id}
        max={bounds.maximum}
        min={bounds.minimum}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        type="number"
        value={Number.isFinite(value) ? value : ''}
      />
      {valid ? null : (
        <p className="text-destructive text-sm" id={errorId}>
          Between {bounds.minimum} and {bounds.maximum} tokens.
        </p>
      )}
    </div>
  );
}

/** A saved config this version cannot read: its remedy saves the defaults in its place. */
function UnreadableSettings({
  message,
  reset,
}: {
  readonly message: string;
  readonly reset: () => Promise<IndexConfig>;
}) {
  const [resetError, run, resetting] = useActionState(async (): Promise<string | null> => {
    try {
      await reset();
      return null;
    } catch (cause) {
      return describeBoundaryError(cause);
    }
  }, null);
  return (
    <div className="space-y-2">
      <p className="text-destructive text-sm" role="alert">
        {message}
      </p>
      <Button
        disabled={resetting}
        onClick={() => startTransition(() => run())}
        type="button"
        variant="outline"
      >
        {resetting ? 'Resetting search settings…' : 'Reset search settings'}
      </Button>
      <p className="text-muted-foreground text-sm">
        Saves the default search settings and rebuilds the index. Chats, folders and your other
        settings are kept.
      </p>
      {resetError ? (
        <p className="text-destructive text-sm" role="alert">
          {resetError}
        </p>
      ) : null}
    </div>
  );
}

function MaintenanceCard({
  nativeIndex,
}: {
  readonly nativeIndex: Pick<IndexSearchCapability, 'rebuild'>;
}) {
  const [rebuildError, rebuild, rebuilding] = useActionState(async (): Promise<string | null> => {
    try {
      await nativeIndex.rebuild();
      return null;
    } catch (cause) {
      return describeBoundaryError(cause);
    }
  }, null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>Clear content is in Factory Reset.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button
          disabled={rebuilding}
          onClick={() => startTransition(() => rebuild())}
          type="button"
          variant="outline"
        >
          {rebuilding ? 'Rebuilding search index…' : 'Rebuild index'}
        </Button>
        <p className="text-muted-foreground text-sm">
          Rebuilds the index from your folders. Folders and settings are kept.
        </p>
        {rebuildError ? (
          <p className="text-destructive text-sm" role="alert">
            {rebuildError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PendingChanges({
  applying,
  blocker,
  error,
  lines,
  onApply,
  onDiscard,
}: {
  readonly applying: boolean;
  readonly blocker: string | null;
  readonly error: string | null;
  readonly lines: readonly string[];
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <div
      aria-label="Pending changes"
      className="border-primary bg-card sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 shadow-md"
      role="status"
    >
      <div className="space-y-1 text-sm">
        <p className="font-semibold">Re-index needed</p>
        <ul className="text-muted-foreground list-disc pl-5">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {blocker ? <p className="text-muted-foreground">{blocker}</p> : null}
        {error ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button disabled={applying} onClick={onDiscard} type="button" variant="outline">
          Discard
        </Button>
        <Button disabled={applying || blocker !== null} onClick={onApply} type="button">
          {applying ? 'Applying…' : 'Apply and re-index'}
        </Button>
      </div>
    </div>
  );
}
