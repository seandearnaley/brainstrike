import { isRetiredModelId } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, GitBranch, GitPullRequest } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import type { ThreadBranchInfo } from './hooks/use-thread-branch-by-root-path';

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
      className="mt-2 mb-2 rounded-md border border-border bg-background/70 p-2"
      data-testid="thread-expanded-details"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
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
      <div className="mt-2 border-border border-t pt-2">
        <div className="font-medium text-[11px] text-muted-foreground">Diagnostics</div>
        <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
          {thread.id}
        </div>
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

const PR_ROLLUP_GLYPH: Readonly<Record<ForgePrCacheEntry['checksRollup'], string>> = {
  failing: '✗',
  none: '·',
  passing: '✓',
  pending: '◐',
};

export function ThreadMetadataBadges({
  branch,
  pr,
  thread,
}: {
  /** Only ever set in folder grouping, and only on desktop. */
  readonly branch: ThreadBranchInfo | null;
  /** Only ever set in folder grouping, and only when the cache has a row. */
  readonly pr: ForgePrCacheEntry | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement | null {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningLabel = getReasoningLabel(thread);
  const maxOutputLabel = getMaxOutputLabel(thread);
  if (!(branch || pr || providerLabel || modelLabel || reasoningLabel || maxOutputLabel)) {
    return null;
  }
  // Whether a badge the narrow band unconditionally protects (branch or PR)
  // is actually rendering. When neither is present, the provider badge takes
  // over that protected slot instead of also hiding until 560px — see the
  // `wideOnly` note on ThreadBadge.
  const protectedBadgePresent = Boolean(branch || pr);
  return (
    <div
      className="@[420px]/threads:flex hidden min-w-0 shrink items-center gap-1 overflow-hidden"
      data-testid="thread-metadata-badges"
    >
      {/* Branch first, then PR: in folder grouping these two are the row's most
          local facts, and they are always visible once the container clears
          420px — see the `wideOnly` note on ThreadBadge for the rest. */}
      <ThreadBranchBadge branch={branch} />
      <ThreadPrBadge pr={pr} />
      <OptionalThreadBadge value={providerLabel} wideOnly={protectedBadgePresent} />
      <OptionalThreadBadge value={modelLabel} wideOnly />
      <OptionalThreadBadge value={reasoningLabel} wideOnly />
      <OptionalThreadBadge value={maxOutputLabel} wideOnly />
    </div>
  );
}

function ThreadBranchBadge({
  branch,
}: {
  readonly branch: ThreadBranchInfo | null;
}): ReactElement | null {
  if (!branch) {
    return null;
  }
  return <ThreadBadge icon={GitBranch}>{branch.detached ? 'detached' : branch.branch}</ThreadBadge>;
}

function ThreadPrBadge({ pr }: { readonly pr: ForgePrCacheEntry | null }): ReactElement | null {
  if (!pr) {
    return null;
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/70 px-1.5 py-0 text-[9px] leading-4 ${
        pr.state === 'open' ? 'text-muted-foreground' : 'text-muted-foreground/60'
      }`}
      data-checks={pr.checksRollup}
      data-state={pr.state}
      data-testid="thread-pr-pill"
      title={`Pull request #${pr.number} (${pr.state})`}
    >
      <GitPullRequest aria-hidden="true" className="size-2.5" />
      {`#${pr.number}`}
      <span aria-hidden="true">
        {pr.isDraft && pr.state === 'open' ? '◌' : PR_ROLLUP_GLYPH[pr.checksRollup]}
      </span>
    </span>
  );
}

function OptionalThreadBadge({
  value,
  wideOnly = false,
}: {
  readonly value: string | null;
  readonly wideOnly?: boolean;
}): ReactElement | null {
  if (!value) {
    return null;
  }
  return <ThreadBadge wideOnly={wideOnly}>{value}</ThreadBadge>;
}

function ThreadBadge({
  children,
  icon: Icon,
  wideOnly,
}: {
  readonly children: ReactNode;
  readonly icon?: LucideIcon;
  /**
   * Hidden until the container clears 560px, INSTEAD of the 420px every other
   * badge in this row gets. Carried per-badge rather than as a positional
   * `nth-child` selector on the container: `nth-child` counts RENDERED
   * children, and branch/PR are both conditional, so a positional rule's
   * meaning shifted with whichever optional badges happened to render —
   * bumping its threshold once (`n+2` to `n+3`) only patched the case with
   * both branch and PR present, and on every row with NEITHER (every row
   * outside folder grouping, and every row on web) it kept a second badge
   * visible in the 420-560px band that previously stayed hidden there,
   * eating into the title's `min-w-0` truncation for rows that have nothing
   * to do with a PR at all. A class the badge carries itself is correct
   * regardless of what else in the row rendered.
   *
   * SPARINGLY conditional: only the provider badge ever passes a computed
   * value here (`protectedBadgePresent` — whether branch or PR rendered).
   * When neither did, provider is the row's first badge and takes over the
   * "always visible in the narrow band" slot branch/PR would otherwise hold
   * — exactly the pre-PR-pill `nth-child(n+2)` behavior, where badge #1 was
   * always shown regardless of what it was. Model/reasoning/max-output stay
   * unconditionally `wideOnly`: they are never the row's first badge, so
   * there is no protected slot for them to inherit.
   */
  readonly wideOnly?: boolean;
}): ReactElement {
  return (
    <span
      className={`${wideOnly ? '@[560px]/threads:inline-flex hidden' : 'inline-flex'} shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/70 px-1.5 py-0 text-[9px] text-muted-foreground leading-4`}
    >
      {Icon ? <Icon aria-hidden="true" className="size-2.5" /> : null}
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
          className="inline-flex size-6 items-center justify-center rounded-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
