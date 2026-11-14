import { isRetiredModelId } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  checkoutName,
  LOCAL_CHECKOUT_NAME,
} from '@brainstrike/assistant-contract/thread-checkout-name';
import type {
  AssistantMemoryThread,
  ThreadRepositoryRow,
  ThreadScratchFolder,
} from '@brainstrike/assistant-data';
import { Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, FolderPen, GitBranch } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};
const THREAD_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function getProviderLabel(provider: string | undefined): string | null {
  if (!provider) {
    return null;
  }
  return PROVIDER_LABELS[provider] ?? provider;
}

function getReasoningValue(thread: AssistantMemoryThread): string | null {
  const provider = thread.latestRun?.provider;
  const providerOptions = thread.latestRun?.providerOptions;
  const providerRecord =
    provider && providerOptions && typeof providerOptions[provider] === 'object'
      ? (providerOptions[provider] as Record<string, unknown>)
      : null;
  const nestedReasoning = providerRecord?.['reasoning'];
  const nestedEffort =
    nestedReasoning && typeof nestedReasoning === 'object'
      ? (nestedReasoning as Record<string, unknown>)['effort']
      : undefined;
  const reasoning =
    providerRecord?.['reasoningEffort'] ?? providerRecord?.['effort'] ?? nestedEffort;
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
}

function getReasoningLabel(thread: AssistantMemoryThread): string | null {
  const value = getReasoningValue(thread);
  return value ? `Reasoning: ${value}` : null;
}

function getMaxOutputValue(thread: AssistantMemoryThread): string | null {
  const value = thread.latestRun?.modelSettings?.['maxOutputTokens'];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function getMaxOutputLabel(thread: AssistantMemoryThread): string | null {
  const value = getMaxOutputValue(thread);
  return value ? `Max output: ${value}` : null;
}

function getThreadModelLabel(thread: AssistantMemoryThread): string | null {
  const model = thread.latestRun?.model;
  if (!model) {
    return null;
  }
  const provider = thread.latestRun?.provider;
  return (provider !== undefined && !isSupportedProvider(provider)) ||
    isRetiredModelId(provider, model)
    ? `Unavailable · ${model}`
    : model;
}

function formatThreadDate(value: Date): string {
  return THREAD_DATE_FORMATTER.format(value);
}

export function ThreadExpandedDetails({
  thread,
}: {
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningValue = getReasoningValue(thread);
  const maxOutputValue = getMaxOutputValue(thread);
  return (
    <div
      className="border-border bg-background/70 mt-1 mb-1 rounded-md border p-2"
      data-testid="thread-expanded-details"
    >
      <div className="text-2xs grid grid-cols-2 gap-x-3 gap-y-2">
        {providerLabel ? <ThreadDetail label="Provider" value={providerLabel} /> : null}
        {modelLabel ? <ThreadDetail label="Model" value={modelLabel} /> : null}
        {thread.latestRun?.runtimeKind ? (
          <ThreadDetail label="Runtime" value={thread.latestRun.runtimeKind} />
        ) : null}
        {thread.latestRun?.status ? (
          <ThreadDetail label="Status" value={thread.latestRun.status} />
        ) : null}
        {reasoningValue ? <ThreadDetail label="Reasoning" value={reasoningValue} /> : null}
        {maxOutputValue ? <ThreadDetail label="Max output" value={maxOutputValue} /> : null}
        {thread.metadata?.operatingRootDisplayName ? (
          <ThreadDetail
            label="Folder"
            title={thread.metadata.operatingRootPath ?? undefined}
            value={thread.metadata.operatingRootDisplayName}
          />
        ) : null}
        <ThreadDetail label="Created" value={formatThreadDate(thread.createdAt)} />
        <ThreadDetail label="Updated" value={formatThreadDate(thread.updatedAt)} />
      </div>
      <div className="border-border mt-2 border-t pt-2">
        <div className="text-muted-foreground text-2xs font-medium">Diagnostics</div>
        <div className="text-muted-foreground text-2xs mt-1 font-mono break-all">{thread.id}</div>
      </div>
    </div>
  );
}

function ThreadDetail({
  label,
  title,
  value,
}: {
  readonly label: string;
  /** Hover text for a value the row truncates — the folder's full path. */
  readonly title?: string | undefined;
  readonly value: string;
}): ReactElement {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-medium" title={title}>
        {value}
      </div>
    </div>
  );
}

/**
 * Where a thread works (ADR-0034, owner decisions 2026-11-10): in a worktree, or in its folder
 * itself ("Local", the composer's own word for it).
 *
 * Read from the thread's committed binding and nothing else. The host writes
 * `checkoutMode: 'worktree'` with the ledger's worktree id and path when a
 * thread moves into a worktree, so the row needs no git call and the chip
 * shows in every grouping. A thread with no folder works nowhere yet and gets
 * no chip.
 *
 * A thread in a scratch folder (ADR-0034) works in that folder itself, but in
 * Project grouping its section, Scratch, names no folder, so its chip names the
 * folder instead of Local: two scratch threads are told apart there. A scratch
 * folder that has become a git repository stays in Scratch, and its chip names
 * its branch as well, so two of those are told apart too.
 */
type ThreadRowCheckout =
  | { readonly kind: 'local' }
  | {
      readonly branch: ThreadScratchBranch | null;
      readonly kind: 'scratch';
      readonly name: string;
      readonly path: string | null;
    }
  | { readonly kind: 'worktree'; readonly name: string; readonly path: string };

/** A scratch folder's branch as its chip shows it, and as its hover text says it. */
interface ThreadScratchBranch {
  readonly label: string;
  readonly title: string;
}

/**
 * The branch of a scratch folder that is a repository's own checkout: its name, or `detached` on
 * a detached HEAD, as a repository section's header shows it. Null while the folder is no git
 * checkout, and for a bare repository, which names neither.
 */
function scratchBranch(repository: ThreadRepositoryRow | null): ThreadScratchBranch | null {
  if (repository?.detached) {
    return { label: 'detached', title: 'on a detached HEAD' };
  }
  if (repository?.branch) {
    return { label: repository.branch, title: `on branch ${repository.branch}` };
  }
  return null;
}

function resolveThreadRowCheckout(
  thread: AssistantMemoryThread,
  scratchFolder: ThreadScratchFolder | null
): ThreadRowCheckout | null {
  const metadata = thread.metadata;
  if (!metadata?.operatingRootId) {
    return null;
  }
  const path = metadata.checkoutMode === 'worktree' ? metadata.checkoutWorktreePath : undefined;
  if (path) {
    // Named as the where-control and the Explorer's header name it.
    return { kind: 'worktree', name: checkoutName(path), path };
  }
  if (scratchFolder?.rootId === metadata.operatingRootId) {
    return {
      branch: scratchBranch(scratchFolder.repository),
      kind: 'scratch',
      name: scratchFolder.displayName,
      path: scratchFolder.path,
    };
  }
  return { kind: 'local' };
}

export function ThreadMetadataBadges({
  scratchFolder,
  thread,
}: {
  /**
   * The scratch folder the thread works in, from its `roots` row, with the repository the listing
   * names for it; null for any other thread and wherever the panel reads no `roots` rows (every
   * grouping but Project).
   */
  readonly scratchFolder: ThreadScratchFolder | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement | null {
  const checkout = resolveThreadRowCheckout(thread, scratchFolder);
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningLabel = getReasoningLabel(thread);
  const maxOutputLabel = getMaxOutputLabel(thread);
  const hasRunBadges = Boolean(providerLabel || modelLabel || reasoningLabel || maxOutputLabel);
  if (!(checkout || hasRunBadges)) {
    return null;
  }
  return (
    <>
      {/* The checkout leads, outside the run badges' container, because it
          keeps its own widths: see ThreadCheckoutBadge. */}
      <ThreadCheckoutBadge checkout={checkout} />
      {hasRunBadges ? (
        <div
          className="hidden min-w-0 shrink items-center gap-1 overflow-hidden @[420px]/threads:flex"
          data-testid="thread-metadata-badges"
        >
          {/* With no checkout chip the provider is the row's first badge and
              shows from 420px; behind one it waits for 560px like the rest. */}
          <OptionalThreadBadge value={providerLabel} wideOnly={checkout !== null} />
          <OptionalThreadBadge value={modelLabel} wideOnly />
          <OptionalThreadBadge value={reasoningLabel} wideOnly />
          <OptionalThreadBadge value={maxOutputLabel} wideOnly />
        </div>
      ) : null}
    </>
  );
}

/** A checkout chip's text: cut to fit, and shown from 420px, where it no longer starves the title. */
const THREAD_CHECKOUT_TEXT_CLASS_NAME = 'hidden max-w-24 truncate @[420px]/threads:inline';

/**
 * The dot between a scratch folder's name and its branch. A flex item of its
 * own, so the badge's gap spaces both its sides: a space inside a truncated
 * text is dropped at the start of its line. Hidden with the texts it divides.
 */
const THREAD_CHECKOUT_SEPARATOR_CLASS_NAME = 'hidden @[420px]/threads:inline';

/**
 * The checkout chip. A Threads panel at its default width leaves a row about
 * 100px for the title and its badges together, and a text chip there cuts the
 * title to a few letters. So under 420px:
 *
 * - a worktree chip is its branch icon alone, which still tells a worktree
 *   thread from a Local one, and its name is on hover; a scratch folder's chip
 *   is its folder icon alone, the same way, its branch hidden with its name;
 * - "Local", the unmarked case, gives way to the title.
 *
 * From 420px each reads in full, where the run badges open too. A scratch
 * folder's branch is a text of its own, cut on its own, so a long branch never
 * hides the folder's name, nor a long name the branch.
 */
function ThreadCheckoutBadge({
  checkout,
}: {
  readonly checkout: ThreadRowCheckout | null;
}): ReactElement | null {
  if (!checkout) {
    return null;
  }
  if (checkout.kind === 'local') {
    return (
      <ThreadBadge band="narrow" testId="thread-checkout-chip" title="Works in the folder itself">
        {LOCAL_CHECKOUT_NAME}
      </ThreadBadge>
    );
  }
  const scratch = checkout.kind === 'scratch';
  const branch = scratch ? checkout.branch : null;
  const label = `${scratch ? 'Scratch folder' : 'Worktree'} ${checkout.name}`;
  const place = checkout.path === null ? label : `${label} at ${checkout.path}`;
  return (
    <ThreadBadge
      band="always"
      icon={scratch ? FolderPen : GitBranch}
      testId="thread-checkout-chip"
      title={branch === null ? place : `${place}, ${branch.title}`}
    >
      <span className={THREAD_CHECKOUT_TEXT_CLASS_NAME}>{checkout.name}</span>
      {branch === null ? null : (
        <>
          <span aria-hidden="true" className={THREAD_CHECKOUT_SEPARATOR_CLASS_NAME}>
            ·
          </span>
          <span className={THREAD_CHECKOUT_TEXT_CLASS_NAME}>{branch.label}</span>
        </>
      )}
    </ThreadBadge>
  );
}

function OptionalThreadBadge({
  value,
  wideOnly = false,
}: {
  readonly value: string | null;
  /**
   * Hidden until the panel clears 560px, INSTEAD of the 420px the run badges'
   * container opens at. Only the provider badge ever passes a computed value
   * here (whether a checkout chip leads the row): with none, provider is the
   * row's first badge and shows from 420px. Model, reasoning and max output
   * are never the row's first badge and always wait for 560px.
   */
  readonly wideOnly?: boolean;
}): ReactElement | null {
  if (!value) {
    return null;
  }
  return <ThreadBadge band={wideOnly ? 'wide' : 'always'}>{value}</ThreadBadge>;
}

/**
 * The narrowest Threads-panel width a badge shows at. Carried per badge rather
 * than as a positional `nth-child` selector on a container: `nth-child` counts
 * RENDERED children and every badge is conditional, so a positional rule's
 * meaning shifted with whichever badges happened to render.
 *
 * Whole class strings, so Tailwind's scanner emits each container query.
 */
const THREAD_BADGE_BAND_CLASS_NAME = {
  always: 'inline-flex',
  narrow: 'hidden @[420px]/threads:inline-flex',
  wide: 'hidden @[560px]/threads:inline-flex',
} as const;

function ThreadBadge({
  band,
  children,
  icon: Icon,
  testId,
  title,
}: {
  readonly band: keyof typeof THREAD_BADGE_BAND_CLASS_NAME;
  readonly children: ReactNode;
  readonly icon?: LucideIcon;
  readonly testId?: string;
  readonly title?: string;
}): ReactElement {
  return (
    <span
      className={`${THREAD_BADGE_BAND_CLASS_NAME[band]} border-border/70 bg-background/70 text-muted-foreground text-2xs shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0 leading-4`}
      data-testid={testId}
      title={title}
    >
      {Icon ? <Icon aria-hidden="true" className="size-2.5 shrink-0" /> : null}
      {children}
    </span>
  );
}

/**
 * A thread whose committed history cannot be read: it still lists and deletes,
 * but never opens or runs. The marker names why, on hover and on focus.
 */
export function ThreadReadFailureMarker({
  reason,
  title,
}: {
  readonly reason: string | undefined;
  readonly title: string;
}): ReactElement | null {
  if (reason === undefined) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A button only so a keyboard can reach the reason; it does nothing else. */}
        <button
          aria-label={`${title}: its history cannot be read. ${reason}`}
          className="text-destructive focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-hidden"
          data-testid="thread-read-failure"
          // Like the row's other controls, a click here never opens the row.
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          <AlertTriangle aria-hidden="true" className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">{reason}</TooltipContent>
    </Tooltip>
  );
}
