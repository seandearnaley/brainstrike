import {
  ActionBarPrimitive,
  type AssistantDataUIProps,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  type DataMessagePartComponent,
  MessagePrimitive,
  type ThreadHistoryAdapter,
  ThreadPrimitive,
  useAssistantDataUI,
  useAui,
  useAuiState,
  useLocalRuntime,
  useMessagePartReasoning,
  // Aliased to a `use`-prefixed name so React Fast Refresh (Vite dev) recognizes
  // it as a hook. Its detection keys on the `use` prefix; an `unstable_use…` call
  // site is missed, so React's real hook count (this hook calls useMemo) exceeds the
  // Fast Refresh signature and throws "Rendered fewer hooks" -- crashing ChatThreadUI
  // + looping the error boundary in dev. Dev-only; prod/tests (no Fast Refresh) were fine.
  unstable_useSlashCommandAdapter as useSlashCommandAdapter,
} from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
  type AssistantToolApprovalRequest,
  type LocalLlmBackendFactory,
  SHELL_OUTPUT_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
// @assistant-ui/styles v0.3.x consolidated all styles into index.css
import '@assistant-ui/styles/index.css';
import './overrides.css';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { ModelPicker } from '../model-picker/model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { AssistantActivityGroup } from './assistant-activity-group';
import { ControlsMenu } from './assistant-controls-menu';
import { shouldShowBackgroundActivity } from './assistant-detail-level';
import {
  AssistantDetailLevelProvider,
  useAssistantDetailLevel,
} from './assistant-detail-level-context';
import { AssistantMessageError } from './assistant-message-error';
import { AssistantMessageText, preloadMarkdownText } from './assistant-message-text';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import {
  AssistantRunTimeline,
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from './assistant-run-timeline';
import {
  AssistantThinkingIndicator,
  BrainstrikeThinkingMark,
} from './assistant-thinking-indicator';
import { AssistantToolApprovalNotice } from './assistant-tool-approval-notice';
import { AssistantToolSuspendNotice, PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { ComposerInputWithTriggers } from './composer-input';
import { ComposerMentionPopover } from './composer-mention-popover';
import { ComposerTriggerPopover } from './composer-trigger-popover';
import {
  type CumulativeUsageDisplay,
  type OmMeterState,
  ThreadContextMeter,
} from './context-usage-meter';
import { useBrainstrikeDataStreamRuntime } from './data-stream-runtime';
import { deriveTaskListFromParts } from './derive-task-list';
import { ExpandableMessageContent } from './expandable-message-content';
import { buildFileMentionAdapter, type FileMention } from './file-mentions';
import { LocalModelStatus } from './local-model-status';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { RunLifecycleNotificationBridge } from './run-lifecycle-notifications';
import { ShellOutputProvider } from './shell-output-context';
import { collectShellOutputs } from './shell-output-parts';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from './slash-commands';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS, TodoProgress } from './todo-progress';
import { runEventsSpanMs, summarizeToolActivity } from './tool-activity';
import { ToolDurationProvider } from './tool-duration-context';
import { collectToolDurations } from './tool-durations';
import { TooltipIconButton } from './tooltip-icon-button';
import { type LocalModelLoadingState, useLocalModelLoading } from './use-local-model-loading';

const AssistantRunTimelineDataPart: DataMessagePartComponent = ({ data }) => {
  // Memory/context background activity (observational memory, semantic recall,
  // context prep, run steps) is internal bookkeeping that wraps the tool calls
  // people care about. Hide every run-event row unless the Detail level is
  // Developer — the default thread is just the grouped tool cards + the answer.
  // EXCEPTION: terminal run failures/cancellations always surface, so a broken
  // turn is never silently swallowed (see isAlwaysVisibleRunEvent).
  const { detailLevel } = useAssistantDetailLevel();
  const showRow = shouldShowBackgroundActivity(detailLevel) || isAlwaysVisibleRunEvent(data);
  // Both selectors are O(total parts) and re-run on every streamed state change.
  // In the default (non-Developer) case — now the common path for every hidden
  // memory/context/run-step row — short-circuit INSIDE the selector so the scans
  // are skipped entirely, not run only to discard the result. The ≤1-per-turn
  // forced failure row pays for the scan, but the flood still skips it. Hooks
  // still run unconditionally (rules-of-hooks safe); only one string primitive
  // is selected.
  const statusOverride = useAuiState((state) =>
    showRow ? resolveAssistantRunEventStatus(state.thread.messages, data) : undefined
  );
  const renderPlanKey = useAuiState((state) => {
    if (!showRow) {
      return 'hidden';
    }
    const plan = resolveAssistantRunEventRenderPlan(state.thread.messages, data);
    return plan.hidden ? 'hidden' : `visible:${plan.repeatCount}`;
  });
  if (renderPlanKey === 'hidden') {
    return null;
  }
  const repeatCount = Number(renderPlanKey.slice('visible:'.length));
  return (
    <AssistantRunTimeline
      data={data}
      repeatCount={repeatCount}
      {...(statusOverride ? { statusOverride } : {})}
    />
  );
};

const AssistantToolApprovalDataPart: DataMessagePartComponent = ({ data }) => (
  <AssistantToolApprovalNotice data={data} />
);

const assistantRunTimelineDataUI = {
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  render: AssistantRunTimelineDataPart,
} satisfies AssistantDataUIProps;

const assistantToolApprovalDataUI = {
  name: TOOL_APPROVAL_DATA_NAME,
  render: AssistantToolApprovalDataPart,
} satisfies AssistantDataUIProps;

const AssistantToolSuspendDataPart: DataMessagePartComponent = ({ data }) => (
  <AssistantToolSuspendNotice data={data} />
);

const assistantToolSuspendDataUI = {
  name: TOOL_SUSPEND_DATA_NAME,
  render: AssistantToolSuspendDataPart,
} satisfies AssistantDataUIProps;

// Live shell-output slices are consumed by the tool card (via collectShellOutputs
// + ShellOutputProvider), NOT rendered inline in the message flow — register a
// null renderer so the transient data parts never surface as stray elements.
const assistantShellOutputDataUI = {
  name: SHELL_OUTPUT_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

// Re-export types needed by consumers
export type { ModelPickerModel, ModelPickerProvider };

export interface ProviderConfig {
  defaultModel: string;
  id: string;
  models: readonly string[];
  name: string;
}

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export interface ProviderModelOptionConfig {
  default?: boolean;
  enabled: boolean;
  id: string;
  label: string;
  supportsStandardDimension?: boolean;
  supportsStreaming?: boolean;
  type: 'llm' | 'embedding';
}

export interface ProviderOptionConfig {
  capabilities: {
    llm: boolean;
    embeddings: boolean;
    streaming: boolean;
    supportsStandardEmbeddingDimension: boolean;
  };
  id: string;
  models: ProviderModelOptionConfig[];
  name: string;
  runtime: ProviderRuntimeCategory;
}

export interface ProviderGroupConfig {
  label: string;
  providers: ProviderOptionConfig[];
  runtime: ProviderRuntimeCategory;
}

export type AssistantToolCategory =
  | 'retrieval'
  | 'action'
  | 'analysis'
  | 'configuration'
  | 'validation';

export type AssistantToolSource = 'native' | 'mcp';

export interface AssistantToolMenuItem {
  category?: AssistantToolCategory | string;
  description?: string;
  disabled?: boolean;
  enabled: boolean;
  group: string;
  id: string;
  inputSchema?: Record<string, unknown>;
  isLocalRuntimeRunnable?: boolean;
  label: string;
  source: AssistantToolSource;
}

export interface AssistantToolMenuConfig {
  isLoading?: boolean;
  items: AssistantToolMenuItem[];
  onOpenSettings?: () => void;
  onRefresh?: () => void;
  onToggleTool?: (toolId: string, enabled: boolean) => void | Promise<void>;
  summary?: string;
}

export interface ComposerDraftCommand {
  readonly id: string;
  readonly mode: 'append' | 'replace';
  readonly text: string;
}

// Provider-settings types live in `@brainstrike/types` so `packages/ui` and
// `packages/preferences` share a single canonical definition. They are
// re-exported here to keep the existing public surface of the
// `@brainstrike/ui/assistant-ui-panel` entry point stable for consumers that
// still import them from this module.
export type {
  AnthropicEffort,
  AssistantProviderSettings,
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
  GoogleThinkingLevel,
  LocalRuntimeActivation,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';

import type {
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';

export interface AssistantUiPanelProps {
  className?: string;
  completePreparedRequest?: (
    requestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
  /** Applies one explicit prompt-library command to the draft without sending it. */
  composerDraftCommand?: ComposerDraftCommand | undefined;
  /** Full model context window size. Passed to the context meter. */
  contextWindow?: number | undefined;
  /** Durable cumulative usage (tokens + cost) for the active thread. Desktop-only. */
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  disabled?: boolean;
  disabledReason?: string;
  /** Effective input budget (contextWindow − output reservation). Passed to the context meter. */
  effectiveInputBudget?: number | undefined;
  /**
   * Workspace files projected into the composer's "@" mention menu. Like
   * `slashCommands`, the panel is presentational: app-shell loads matches from
   * the file index for the active mention query (reported via
   * `onFileMentionQueryChange`) and feeds the resolved candidates here.
   * Selecting one inserts a `:file[…]{name=…}` directive the server resolves to
   * the file's content. The "@" feature is mounted only when
   * `onFileMentionQueryChange` is provided (capability/seam gating lives in the
   * app — web omits it).
   */
  fileMentions?: readonly FileMention[];
  historyAdapter?: ThreadHistoryAdapter;
  loadLocalLlmBackend?: LocalLlmBackendFactory;
  /**
   * Transport for the built-in local provider. 'data-stream' routes local
   * chat through the assistant server (real Mastra loop: memory, run events,
   * tool guards) with inference proxied to the hidden llm-host — desktop
   * only. 'local-runtime' (default) keeps the in-renderer assistant-ui local
   * runtime (web, or desktop without the llm-host bridge).
   */
  localChatTransport?: 'data-stream' | 'local-runtime';
  omSegment?: OmMeterState | undefined;
  /** Acknowledges a composer command only after its text is visible in the draft. */
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  /** Reports the live draft so prompt suggestions can use the user's actual context. */
  onComposerTextChange?: ((text: string) => void) | undefined;
  /**
   * Clear the persisted plan-mode preference. Called when the user APPROVES a
   * submitted plan so the resume request exits plan mode and the rebuilt server
   * runtime unlocks the mutation tools. Absent → approving a plan leaves plan
   * mode unchanged.
   */
  onExitPlanMode?: () => void;
  /**
   * Reports the active "@" mention query so the app can load matching files into
   * `fileMentions`. Presence of this callback gates the "@" feature on.
   */
  onFileMentionQueryChange?: (query: string) => void;
  onModelChange?: (compositeKey: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  /**
   * Reports a `run.failed` run event exactly once (deduped by event id).
   * Only ever fires for the Mastra-loop transport (hosted providers / desktop
   * local-via-data-stream) — the in-renderer local runtime has no run events.
   */
  onRunFailed?: (event: AssistantRunEvent) => void;
  /** Reports a `run.finished` run event exactly once (deduped by event id). */
  onRunFinished?: (event: AssistantRunEvent) => void;
  /** Liveness signal fired for each streamed assistant chunk/snapshot. */
  onStreamActivity?: () => void;
  onThreadRunStart?: () => void;
  /** Toggle the persisted plan-mode preference. Absent → no toggle is shown. */
  onTogglePlanMode?: () => void;
  /**
   * Reports a tool-approval-required pause exactly once, deduped by
   * `runId:toolCallId` (a later re-render of the same pause is not a new
   * request).
   */
  onToolApprovalRequired?: (request: AssistantToolApprovalRequest) => void;
  /** Called with the provider's exact token counts from a finish-message chunk. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Models for the ModelPicker component */
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  /** Current persisted plan-mode state; drives the composer toggle's pressed look. */
  planModeEnabled?: boolean;
  prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
  providerGroups?: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  providers?: ProviderConfig[];
  requestData?: Record<string, unknown>;
  selectedModel?: string;
  selectedProvider?: string;
  /**
   * App commands projected into the composer's "/" slash menu. The panel is
   * presentational — it never builds the command registry. The app (app-shell)
   * derives these from its command registry (capability-gated, danger group
   * excluded) and pre-binds each `execute` to the command's `run(ctx)`. Defaults
   * to `[]`, so callers/web with no commands simply show nothing.
   */
  slashCommands?: readonly SlashCommand[];
  threadKey?: string;
  toolMenu?: AssistantToolMenuConfig;
}

export type AssistantUiThreadHistoryAdapter = ThreadHistoryAdapter;

declare global {
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

const LocalReasoningPart = () => {
  useMessagePartReasoning();

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
      <p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Model reasoning
      </p>
      <div className="text-muted-foreground text-sm leading-6" data-testid="local-reasoning-part">
        <AssistantMessageText />
      </div>
    </div>
  );
};

function isRunningReasoningPart(part: unknown): boolean {
  if (!(part && typeof part === 'object')) {
    return false;
  }

  if ((part as { readonly type?: unknown }).type !== 'reasoning') {
    return false;
  }

  const status = (part as { readonly status?: unknown }).status;
  if (!(status && typeof status === 'object')) {
    return false;
  }

  return (status as { readonly type?: unknown }).type === 'running';
}

/** Renders nothing — used to keep reasoning parts out of the flow while collapsed. */
const HiddenReasoningPart = () => null;

function isReasoningPart(part: unknown): boolean {
  return Boolean(
    part && typeof part === 'object' && (part as { readonly type?: unknown }).type === 'reasoning'
  );
}

function reasoningToggleLabel(collapsed: boolean, isContinuation: boolean): string {
  if (collapsed) {
    return isContinuation ? 'Show additional reasoning' : 'Show reasoning';
  }
  return isContinuation ? 'Hide additional reasoning' : 'Hide reasoning';
}

/**
 * The collapsible reasoning fold: a pill that toggles the reasoning panel.
 * Tool cards always render inside the panel (the reasoning collapse only hides
 * reasoning parts), so the panel stays mounted to keep `aria-controls` valid.
 */
const ChainReasoningFold = ({
  children,
  collapsed,
  isContinuation,
  isReasoningRunning,
  onToggle,
  panelId,
}: {
  children: ReactNode;
  collapsed: boolean;
  isContinuation: boolean;
  isReasoningRunning: boolean;
  onToggle: () => void;
  panelId: string;
}) => (
  <>
    <button
      aria-controls={panelId}
      aria-expanded={!collapsed}
      aria-label={reasoningToggleLabel(collapsed, isContinuation)}
      className={cn(
        'inline-flex h-8 max-w-full items-center rounded-full border border-border/70 bg-muted/20 text-left font-medium text-foreground text-xs transition-colors hover:bg-muted/35',
        isContinuation ? 'w-8 justify-center px-0' : 'gap-2 px-2.5'
      )}
      data-testid="local-chain-of-thought"
      onClick={onToggle}
      type="button"
    >
      {isReasoningRunning ? (
        <AssistantThinkingIndicator
          className={cn('min-w-0', isContinuation ? 'justify-center' : '')}
          markClassName="size-4"
          showText={!isContinuation}
          textClassName="truncate"
        />
      ) : (
        <span
          className={cn('bs-thinking-indicator min-w-0', isContinuation ? 'justify-center' : '')}
          data-testid="assistant-reasoning-indicator"
        >
          <BrainstrikeThinkingMark
            className="bs-thinking-mark-static size-4"
            testId="assistant-reasoning-static-mark"
          />
          {isContinuation ? null : <span className="truncate">Reasoning</span>}
        </span>
      )}
      {isContinuation ? null : collapsed ? (
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
    <div
      className={cn(
        'bs-chain-of-thought-panel mt-2 empty:mt-0',
        collapsed ? '' : 'border-border/70 border-l pl-3'
      )}
      id={panelId}
    >
      {children}
    </div>
  </>
);

function isActivityPart(part: unknown): boolean {
  if (!(part && typeof part === 'object')) {
    return false;
  }
  const type = (part as { type?: unknown }).type;
  return type === 'tool-call' || type === 'reasoning';
}

/** Stable React key for an activity row: the tool call id, else its position. */
function activityPartKey(part: unknown, index: number): string {
  if (part && typeof part === 'object') {
    const id = (part as { toolCallId?: unknown }).toolCallId;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return `activity-${index}`;
}

const LocalChainOfThought = () => {
  const aui = useAui();
  const collapsed = useAuiState((state) => state.chainOfThought.collapsed);
  const messageParts = useAuiState((state) => state.message.parts);
  const hasReasoningParts = useAuiState((state) => state.message.parts.some(isReasoningPart));
  const isReasoningRunning = useAuiState((state) =>
    state.message.parts.some(isRunningReasoningPart)
  );
  const isMessageRunning = useAuiState(
    (state) => (state.message as { status?: { type?: string } }).status?.type === 'running'
  );
  // The Mastra agent loop puts each tool call in its own step, which
  // assistant-ui splits into a SEPARATE chain-of-thought group. To group the
  // whole turn into ONE Activity panel ("Worked · N steps"), the FIRST chain
  // renders every tool/reasoning part of the message (by index, so streaming
  // binding is preserved) and every later chain renders nothing.
  const isFirstChain = useAuiState((state) => {
    const firstActivity = state.message.parts.find(isActivityPart);
    if (!firstActivity) {
      return true;
    }
    return state.chainOfThought.parts.find(isActivityPart) === firstActivity;
  });
  // `index:stableKey` for each activity part, built in ONE pass (the selector
  // re-runs on every streamed update). Selecting a string primitive keeps
  // re-render semantics stable; the stable key avoids array-index keys.
  const activityKey = useAuiState((state) => {
    const entries: string[] = [];
    for (const [index, part] of state.message.parts.entries()) {
      if (isActivityPart(part)) {
        entries.push(`${index}:${activityPartKey(part, index)}`);
      }
    }
    return entries.join(',');
  });

  const toolActivity = useMemo(() => summarizeToolActivity(messageParts), [messageParts]);
  const activityFallbackMs = useMemo(() => runEventsSpanMs(messageParts), [messageParts]);
  const toolDurations = useMemo(() => collectToolDurations(messageParts), [messageParts]);
  const shellOutputs = useMemo(() => collectShellOutputs(messageParts), [messageParts]);
  const taskList = useMemo(() => deriveTaskListFromParts(messageParts), [messageParts]);

  const initializedRef = useRef(false);
  const reasoningPanelId = useId();

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    aui.chainOfThought().setCollapsed(true);
  }, [aui]);

  // Later chains are already covered by the first chain's turn-level group.
  if (!isFirstChain) {
    return null;
  }

  const activityEntries =
    activityKey === ''
      ? []
      : activityKey.split(',').map((entry) => {
          const separator = entry.indexOf(':');
          return { index: Number(entry.slice(0, separator)), key: entry.slice(separator + 1) };
        });

  // Render each tool/reasoning part by index — this keeps assistant-ui's live
  // streaming binding while letting us group across step boundaries.
  const activityParts = activityEntries.map(({ index, key }) => (
    <div className="mb-2 last:mb-0 empty:mb-0" key={key}>
      <MessagePrimitive.PartByIndex
        components={{
          /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Reasoning" key */
          Reasoning: collapsed ? HiddenReasoningPart : LocalReasoningPart,
          tools: CHAIN_OF_THOUGHT_TOOL_COMPONENTS,
        }}
        index={index}
      />
    </div>
  ));

  // Only reasoning lives behind the collapsible pill; tool cards always render.
  const reasoningSection = hasReasoningParts ? (
    <ChainReasoningFold
      collapsed={collapsed}
      isContinuation={false}
      isReasoningRunning={isReasoningRunning}
      onToggle={() => aui.chainOfThought().setCollapsed(!collapsed)}
      panelId={reasoningPanelId}
    >
      {activityParts}
    </ChainReasoningFold>
  ) : (
    activityParts
  );

  const isActivityActive = toolActivity.runningCount > 0 || isReasoningRunning || isMessageRunning;
  // A FINISHED lone tool call (no reasoning) is more useful as just the card —
  // the "Worked · 1 step" wrapper adds nothing. While the turn is still active
  // we always group, so streaming tools land in a stable container instead of a
  // bare card that pops into a group when the second tool arrives.
  const isSingleTool = !isActivityActive && toolActivity.stepCount === 1 && !hasReasoningParts;

  let content: ReactNode = reasoningSection;
  if (isSingleTool) {
    content = activityParts;
  } else if (toolActivity.stepCount > 0) {
    content = (
      <AssistantActivityGroup
        fallbackMs={activityFallbackMs}
        isActive={isActivityActive}
        summary={toolActivity}
      >
        {reasoningSection}
      </AssistantActivityGroup>
    );
  }

  return (
    <ChainOfThoughtPrimitive.Root className="bs-chain-of-thought mb-2 block max-w-xl">
      {taskList ? <TodoProgress result={taskList} /> : null}
      <ToolDurationProvider durations={toolDurations}>
        <ShellOutputProvider outputs={shellOutputs}>{content}</ShellOutputProvider>
      </ToolDurationProvider>
    </ChainOfThoughtPrimitive.Root>
  );
};

const AssistantDataRendererRegistration = () => {
  useAssistantDataUI(assistantRunTimelineDataUI);
  useAssistantDataUI(assistantToolApprovalDataUI);
  useAssistantDataUI(assistantToolSuspendDataUI);
  useAssistantDataUI(assistantShellOutputDataUI);

  return null;
};

// Keep this in sync with the collapsed-history nth-last-child selector in overrides.css.
const COLLAPSED_HISTORY_VISIBLE_MESSAGES = 8;

// Stable empty default for the optional slashCommands prop. A literal `[]`
// default would create a new array each render, breaking memoization in the
// adapter/icon-map derivations downstream (react-doctor: empty default prop).
const EMPTY_SLASH_COMMANDS: readonly SlashCommand[] = [];

// Stable empty default for the optional fileMentions prop (same memoization
// rationale as EMPTY_SLASH_COMMANDS — a literal `[]` would churn the adapter).
const EMPTY_FILE_MENTIONS: readonly FileMention[] = [];

const ThreadHistoryControl = ({
  controlsId,
  expanded,
  hiddenMessageCount,
  onExpandedChange,
}: {
  controlsId: string;
  expanded: boolean;
  hiddenMessageCount: number;
  onExpandedChange: (expanded: boolean) => void;
}) => {
  if (hiddenMessageCount <= 0) {
    return null;
  }

  return (
    <div aria-live="polite" className="bs-history-control" data-testid="assistant-history-control">
      <button
        aria-controls={controlsId}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${hiddenMessageCount} previous messages`}
        className="bs-history-control-button"
        data-testid="assistant-history-toggle"
        onClick={() => onExpandedChange(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronUpIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        )}
        <span>{hiddenMessageCount} previous messages</span>
      </button>
    </div>
  );
};

// Shared props for inner chat components
interface ChatThreadProps {
  completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: 'cancelled' | 'completed' | 'failed',
        error?: string
      ) => Promise<void> | void)
    | undefined;
  composerDraftCommand?: ComposerDraftCommand | undefined;
  contextWindow?: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  disabled: boolean;
  disabledReason: string | undefined;
  effectiveInputBudget?: number | undefined;
  fileMentions: readonly FileMention[];
  loadLocalLlmBackend?: LocalLlmBackendFactory | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  omSegment?: OmMeterState | undefined;
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  onComposerTextChange?: ((text: string) => void) | undefined;
  onFileMentionQueryChange: ((query: string) => void) | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  onStreamActivity?: (() => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  onUsage?: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  /** Composer plan-mode toggle; absent → no toggle rendered. */
  planMode?: { enabled: boolean; onExit?: () => void; onToggle: () => void } | undefined;
  prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
  providerGroups: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  requestData?: Record<string, unknown> | undefined;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  slashCommands: readonly SlashCommand[];
  toolMenu?: AssistantToolMenuConfig | undefined;
}

/**
 * Inner component for local runtime (browser-based inference).
 * Uses useLocalRuntime with LocalLlmBackend via transformers.js.
 */
const LocalRuntimeChat = ({
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  omSegment,
  effectiveInputBudget,
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onRunFailed,
  onRunFinished,
  onStreamActivity,
  onThreadRunStart,
  onToolApprovalRequired,
  onUsage,
  disabled,
  disabledReason,
  localLoadingState,
  loadLocalLlmBackend,
  modelId,
  onLoadingStateChange,
  slashCommands,
  fileMentions,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  planMode,
  toolMenu,
  requestData,
  prepareRequestData,
  completePreparedRequest,
  threadKey,
}: ChatThreadProps & {
  modelId: string;
  onLoadingStateChange: (state: LocalModelLoadingState) => void;
  threadKey?: string | undefined;
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);
  const thinkingEnabled =
    providerSettings?.[selectedProvider ?? 'local']?.localThinkingEnabled ?? true;

  // Create adapter with memoization to avoid re-creating on every render
  const adapter = useMemo(
    () =>
      createLocalModelAdapter({
        ...(loadLocalLlmBackend ? { loadBackend: loadLocalLlmBackend } : {}),
        modelId,
        thinkingEnabled,
        ...(requestData ? { runtimeData: requestData } : {}),
        prepareRuntimeData: async () => ({
          ...(requestData ?? {}),
          ...((await prepareRequestData?.()) ?? {}),
        }),
        ...(completePreparedRequest ? { completeRuntimeData: completePreparedRequest } : {}),
        ...(onStreamActivity ? { onActivity: onStreamActivity } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(toolMenu?.items ? { tools: toolMenu.items } : {}),
        onError: (error: Error) => {
          onLoadingStateChange({
            message: error.message,
            progress: 0,
            stage: 'error',
          });
        },
        onLoadingProgress: (progress: LocalModelLoadingState) => {
          onLoadingStateChange(progress);
        },
      }),
    [
      completePreparedRequest,
      loadLocalLlmBackend,
      modelId,
      onLoadingStateChange,
      onStreamActivity,
      onUsage,
      prepareRequestData,
      requestData,
      thinkingEnabled,
      toolMenu?.items,
    ]
  );

  const runtime = useLocalRuntime(adapter);

  // Cleanup on unmount
  useEffect(
    () => () => {
      void disposeLocalBackend();
    },
    []
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantPanelErrorBoundary>
        <ChatThreadUI
          composerDraftCommand={composerDraftCommand}
          contextWindow={contextWindow}
          cumulativeUsage={cumulativeUsage}
          disabledReason={disabledReason}
          effectiveInputBudget={effectiveInputBudget}
          fileMentions={fileMentions}
          hasGroupedProviders={hasGroupedProviders}
          isComposerDisabled={isComposerDisabled}
          localLoadingState={localLoadingState}
          omSegment={omSegment}
          onComposerDraftCommandApplied={onComposerDraftCommandApplied}
          onComposerTextChange={onComposerTextChange}
          onFileMentionQueryChange={onFileMentionQueryChange}
          onModelChange={onModelChange}
          onProviderSettingsChange={onProviderSettingsChange}
          onRunFailed={onRunFailed}
          onRunFinished={onRunFinished}
          onThreadRunStart={onThreadRunStart}
          onToolApprovalRequired={onToolApprovalRequired}
          pickerModels={pickerModels}
          pickerProviders={pickerProviders}
          {...(planMode ? { planMode } : {})}
          providerGroups={providerGroups}
          providerSettings={providerSettings}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          slashCommands={slashCommands}
          threadKey={threadKey}
          toolMenu={toolMenu}
        />
      </AssistantPanelErrorBoundary>
    </AssistantRuntimeProvider>
  );
};

/**
 * Inner component for data stream runtime (server-side hosted providers).
 * Uses useDataStreamRuntime for API-based inference.
 */
const DataStreamRuntimeChat = ({
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  omSegment,
  effectiveInputBudget,
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onRunFailed,
  onRunFinished,
  onStreamActivity,
  onThreadRunStart,
  onToolApprovalRequired,
  onUsage,
  disabled,
  disabledReason,
  localLoadingState,
  api,
  completePreparedRequest,
  historyAdapter,
  requestData,
  prepareRequestData,
  prepareLocalModel,
  modelName,
  slashCommands,
  fileMentions,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  planMode,
  toolMenu,
  threadKey,
}: ChatThreadProps & {
  api: string;
  completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: 'cancelled' | 'completed' | 'failed',
        error?: string
      ) => Promise<void> | void)
    | undefined;
  historyAdapter: ThreadHistoryAdapter | undefined;
  requestData: Record<string, unknown> | undefined;
  prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
  /** Pre-request hook: warms the built-in local model (with progress UI) before streaming. */
  prepareLocalModel?: (() => Promise<void>) | undefined;
  modelName: string | undefined;
  threadKey?: string | undefined;
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);
  const preparedRequestRef = useRef<{ readonly data: Record<string, unknown> | undefined } | null>(
    null
  );
  const completePreparedRequestRef = useRef(completePreparedRequest);
  completePreparedRequestRef.current = completePreparedRequest;

  const completeLatestPreparedRequest = useCallback(
    async (status: 'cancelled' | 'completed' | 'failed', error?: string): Promise<void> => {
      const preparedRequest = preparedRequestRef.current;
      if (!preparedRequest) {
        return;
      }
      preparedRequestRef.current = null;
      await completePreparedRequestRef.current?.(preparedRequest.data, status, error);
    },
    []
  );

  const runtime = useBrainstrikeDataStreamRuntime({
    api,
    ...(historyAdapter ? { adapters: { history: historyAdapter } } : {}),
    body: async () => {
      if (preparedRequestRef.current) {
        throw new Error('Cannot start a hosted assistant run while another run is in progress.');
      }
      // Warm the local model first so cold downloads surface progress in the
      // renderer instead of stalling silently inside the server-side stream.
      if (prepareLocalModel) {
        await prepareLocalModel();
      }
      const preparedRequestData = prepareRequestData ? await prepareRequestData() : undefined;
      preparedRequestRef.current = { data: preparedRequestData };
      return {
        data: {
          ...(requestData ?? {}),
          ...(preparedRequestData ?? {}),
          model: modelName,
          provider: selectedProvider,
        },
      };
    },
    ...(onStreamActivity ? { onActivity: onStreamActivity } : {}),
    onCancel: () => {
      void completeLatestPreparedRequest('cancelled');
    },
    onError: (error: Error) => {
      void completeLatestPreparedRequest('failed', error.message);
    },
    onFinish: () => {
      void completeLatestPreparedRequest('completed');
    },
    ...(onUsage ? { onUsage } : {}),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PlanModeExitProvider onExit={planMode?.onExit}>
        <AssistantPanelErrorBoundary>
          <ChatThreadUI
            composerDraftCommand={composerDraftCommand}
            contextWindow={contextWindow}
            cumulativeUsage={cumulativeUsage}
            disabledReason={disabledReason}
            effectiveInputBudget={effectiveInputBudget}
            fileMentions={fileMentions}
            hasGroupedProviders={hasGroupedProviders}
            isComposerDisabled={isComposerDisabled}
            localLoadingState={localLoadingState}
            omSegment={omSegment}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onFileMentionQueryChange={onFileMentionQueryChange}
            onModelChange={onModelChange}
            onProviderSettingsChange={onProviderSettingsChange}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            pickerModels={pickerModels}
            pickerProviders={pickerProviders}
            {...(planMode ? { planMode } : {})}
            providerGroups={providerGroups}
            providerSettings={providerSettings}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            slashCommands={slashCommands}
            threadKey={threadKey}
            toolMenu={toolMenu}
          />
        </AssistantPanelErrorBoundary>
      </PlanModeExitProvider>
    </AssistantRuntimeProvider>
  );
};

function useComposerDraftCommand({
  command,
  onApplied,
  onTextChange,
}: {
  command: ComposerDraftCommand | undefined;
  onApplied: ((commandId: string) => void) | undefined;
  onTextChange: ((text: string) => void) | undefined;
}): void {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const appliedCommandIdsRef = useRef(new Set<string>());

  useEffect(() => {
    onTextChange?.(composerText);
  }, [composerText, onTextChange]);

  useEffect(() => {
    if (!command || appliedCommandIdsRef.current.has(command.id)) {
      return;
    }
    if (!command.text.trim()) {
      throw new Error('Composer draft commands require non-whitespace text.');
    }

    const nextText =
      command.mode === 'append' && composerText.length > 0
        ? `${composerText}\n\n${command.text}`
        : command.text;
    aui.composer().setText(nextText);
    appliedCommandIdsRef.current.add(command.id);
    onApplied?.(command.id);
  }, [aui, command, composerText, onApplied]);
}

/**
 * Shared UI component for the chat thread.
 * Extracted to avoid duplication between local and data stream runtimes.
 */
const ChatThreadUI = ({
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  omSegment,
  effectiveInputBudget,
  providerGroups,
  hasGroupedProviders,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onRunFailed,
  onRunFinished,
  onThreadRunStart,
  onToolApprovalRequired,
  isComposerDisabled,
  disabledReason,
  localLoadingState,
  slashCommands,
  fileMentions,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  planMode,
  threadKey,
  toolMenu,
}: {
  composerDraftCommand?: ComposerDraftCommand | undefined;
  contextWindow?: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  omSegment?: OmMeterState | undefined;
  effectiveInputBudget?: number | undefined;
  planMode?: { enabled: boolean; onExit?: () => void; onToggle: () => void } | undefined;
  providerGroups: ProviderGroupConfig[];
  hasGroupedProviders: boolean;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider: string | undefined;
  selectedModel: string | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  isComposerDisabled: boolean;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  slashCommands: readonly SlashCommand[];
  fileMentions: readonly FileMention[];
  onFileMentionQueryChange: ((query: string) => void) | undefined;
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  onComposerTextChange?: ((text: string) => void) | undefined;
  threadKey?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}) => {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const messageCount = useAuiState((state) => state.thread.messages.length);
  const hiddenMessageCount = Math.max(0, messageCount - COLLAPSED_HISTORY_VISIBLE_MESSAGES);
  const historyCollapsed = hiddenMessageCount > 0 && !historyExpanded;
  const messagesRegionId = useId();

  useComposerDraftCommand({
    command: composerDraftCommand,
    onApplied: onComposerDraftCommandApplied,
    onTextChange: onComposerTextChange,
  });

  // Slash-command "/" menu: derive the library adapter + icon lookup from the
  // app-passed commands during render (no setState-in-effect). The adapter hook
  // is memoized on the command list and always runs (rules-of-hooks), but the
  // slash popover is only MOUNTED when there are commands — the installed
  // @assistant-ui opens the popover whenever "/" is typed and an adapter is
  // present, regardless of whether search() returns items, so mounting it with
  // an empty list would surface an empty menu. "No commands" ⇒ no slash feature.
  const hasSlashCommands = slashCommands.length > 0;
  const slashAdapterOptions = useMemo(
    () => toSlashCommandAdapterOptions(slashCommands),
    [slashCommands]
  );
  const { adapter: slashAdapter, action: slashAction } =
    useSlashCommandAdapter(slashAdapterOptions);
  const slashIconMap = useMemo(() => buildSlashCommandIconMap(slashCommands), [slashCommands]);

  // "@" file-mention menu: mounted only when app-shell wires the query seam
  // (web omits it — capability/seam gating lives in the app, not here). The
  // adapter is synchronous; app-shell loads matches for the reported query and
  // feeds them back as `fileMentions`, which rebuilds the adapter.
  const hasFileMentions = Boolean(onFileMentionQueryChange);
  const fileMentionAdapter = useMemo(
    () =>
      onFileMentionQueryChange
        ? buildFileMentionAdapter(fileMentions, onFileMentionQueryChange)
        : null,
    [fileMentions, onFileMentionQueryChange]
  );
  const fileMentionById = useMemo(
    () => new Map(fileMentions.map((file) => [file.id, file])),
    [fileMentions]
  );

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col"
      data-history-collapsed={historyCollapsed ? 'true' : undefined}
    >
      <AssistantDataRendererRegistration />
      <RunLifecycleNotificationBridge
        {...(onRunFailed ? { onRunFailed } : {})}
        {...(onRunFinished ? { onRunFinished } : {})}
        {...(onToolApprovalRequired ? { onToolApprovalRequired } : {})}
        {...(threadKey ? { threadKey } : {})}
      />
      {/**
       * Messages Viewport
       *
       * CRITICAL: className only includes "aui-thread-viewport" - NO additional Tailwind classes
       *
       * WHY: The @assistant-ui library applies its own classes via @apply in CSS.
       * Adding Tailwind classes here (flex-1, overflow-y-auto, etc.) creates conflicts.
       *
       * All layout constraints are handled in overrides.css with !important declarations
       * to override the library's defaults.
       *
       * See: packages/ui/src/assistant-ui-panel/overrides.css
       */}
      <ThreadPrimitive.Viewport
        aria-atomic="false"
        aria-live="polite"
        autoScroll
        className="aui-thread-viewport"
        data-testid="assistant-ui-viewport"
        id={messagesRegionId}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnRunStart={false}
      >
        {disabledReason && (
          <p aria-live="polite" className="px-4 py-3 text-muted-foreground text-xs">
            {disabledReason}
          </p>
        )}
        <ThreadHistoryControl
          controlsId={messagesRegionId}
          expanded={historyExpanded}
          hiddenMessageCount={hiddenMessageCount}
          onExpandedChange={setHistoryExpanded}
        />
        <ThreadPrimitive.Messages
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            AssistantMessage,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            EditComposer,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
            UserMessage,
          }}
        />
      </ThreadPrimitive.Viewport>

      {/**
       * Composer: Fixed at bottom of thread
       *
       * STRUCTURE: This is a SIBLING to the viewport, not a child
       *
       * LAYOUT:
       * - flex-shrink-0: Never shrinks, always maintains its height
       * - Viewport above is flex-1: Grows/shrinks to fill available space
       * - This pattern ensures composer stays at bottom regardless of message content
       *
       * LIBRARY DIFFERENCE:
       * The @assistant-ui library expects the composer INSIDE the viewport as:
       *   <ThreadPrimitive.Viewport>
       *     <Messages />
       *     <div className="aui-thread-viewport-footer" style="position: sticky">
       *       <Composer />
       *     </div>
       *   </ThreadPrimitive.Viewport>
       *
       * We extracted it outside to avoid scrolling with messages.
       * This required aggressive CSS overrides (see overrides.css).
       */}
      <div className="bs-composer-shell" data-testid="assistant-composer-shell">
        <ThreadContextMeter
          contextWindow={contextWindow}
          cumulativeUsage={cumulativeUsage}
          effectiveInputBudget={effectiveInputBudget}
          omSegment={omSegment}
          threadKey={threadKey}
        />
        {localLoadingState && <LocalModelStatus state={localLoadingState} />}
        <ComposerPrimitive.Root
          aria-disabled={isComposerDisabled}
          className="aui-composer-root"
          data-disabled={isComposerDisabled ? '' : undefined}
          onSubmitCapture={onThreadRunStart}
        >
          {/* The composer input row, optionally wrapped in a shared
              `Unstable_TriggerPopoverRoot` (see `ComposerInputWithTriggers`).
              Each popover declares its own trigger char ("/" vs "@") and both
              read the same composer text via that shared root, coexisting as
              siblings. A feature is mounted ONLY when its seam is present —
              an unmounted popover means the trigger char does nothing special
              (never an empty menu). Send / Cancel are unchanged. */}
          <ComposerInputWithTriggers
            isComposerDisabled={isComposerDisabled}
            {...(planMode ? { planMode } : {})}
            {...(hasSlashCommands
              ? {
                  slashPopover: (
                    <ComposerTriggerPopover
                      action={slashAction}
                      adapter={slashAdapter}
                      iconMap={slashIconMap}
                    />
                  ),
                }
              : {})}
            {...(hasFileMentions && fileMentionAdapter
              ? {
                  mentionPopover: (
                    <ComposerMentionPopover
                      adapter={fileMentionAdapter}
                      fileById={fileMentionById}
                    />
                  ),
                }
              : {})}
          />
          {hasGroupedProviders && (
            <ProviderModelHeader
              groups={providerGroups}
              onModelChange={onModelChange}
              onProviderSettingsChange={onProviderSettingsChange}
              pickerModels={pickerModels}
              pickerProviders={pickerProviders}
              providerSettings={providerSettings}
              selectedModel={selectedModel}
              selectedProvider={selectedProvider}
              toolMenu={toolMenu}
            />
          )}
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
};

// Pure UI layer: state management and data wiring live in app-shell wrapper(s).
export const AssistantUiPanel = ({
  className,
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  omSegment,
  completePreparedRequest,
  effectiveInputBudget,
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  requestData,
  prepareRequestData,
  onModelChange,
  onExitPlanMode,
  onRunFailed,
  onRunFinished,
  onStreamActivity,
  onThreadRunStart,
  onTogglePlanMode,
  onToolApprovalRequired,
  onUsage,
  planModeEnabled,
  slashCommands = EMPTY_SLASH_COMMANDS,
  fileMentions = EMPTY_FILE_MENTIONS,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  toolMenu,
  disabled = false,
  disabledReason,
  historyAdapter,
  loadLocalLlmBackend,
  localChatTransport = 'local-runtime',
  threadKey,
}: AssistantUiPanelProps) => {
  // API URL for data stream runtime (hosted providers)
  const initialApi =
    typeof window === 'undefined'
      ? '/api/assistant'
      : window.assistant?.url
        ? `${window.assistant.url}/assistant`
        : '/api/assistant';
  const [api, setApi] = useState<string>(initialApi);

  useEffect(() => {
    void preloadMarkdownText();

    const getUrl = window.assistant?.getUrl;
    if (!getUrl) {
      return;
    }
    const updateApi = async () => {
      try {
        const url = await getUrl();
        if (url) {
          setApi(`${url}/assistant`);
        }
      } catch {
        // Ignore errors from getUrl
      }
    };

    void updateApi();
  }, []);

  const groupedProviders = providerGroups ?? [];

  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  // Check if using local provider
  const isLocalProvider = selectedProvider === 'local';
  const localViaDataStream = isLocalProvider && localChatTransport === 'data-stream';

  const { handleLocalLoadingStateChange, localLoadingState, prepareLocalModel } =
    useLocalModelLoading({ localViaDataStream, modelName });

  return (
    <AssistantDetailLevelProvider>
      <section
        aria-label="Assistant chat"
        className={cn('assistant-ui-panel flex h-full min-h-0 flex-col', className)}
        data-testid="chat-panel"
      >
        {isLocalProvider && modelName && !localViaDataStream ? (
          <LocalRuntimeChat
            completePreparedRequest={completePreparedRequest}
            composerDraftCommand={composerDraftCommand}
            contextWindow={contextWindow}
            cumulativeUsage={cumulativeUsage}
            disabled={disabled}
            disabledReason={disabledReason}
            effectiveInputBudget={effectiveInputBudget}
            key={threadKey ? `local:${threadKey}` : 'local'}
            loadLocalLlmBackend={loadLocalLlmBackend}
            localLoadingState={localLoadingState}
            modelId={modelName}
            omSegment={omSegment}
            onLoadingStateChange={handleLocalLoadingStateChange}
            onModelChange={onModelChange}
            onProviderSettingsChange={onProviderSettingsChange}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onStreamActivity={onStreamActivity}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            {...(onUsage ? { onUsage } : {})}
            fileMentions={fileMentions}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onFileMentionQueryChange={onFileMentionQueryChange}
            pickerModels={pickerModels}
            pickerProviders={pickerProviders}
            prepareRequestData={prepareRequestData}
            providerGroups={groupedProviders}
            providerSettings={providerSettings}
            requestData={requestData}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            slashCommands={slashCommands}
            threadKey={threadKey}
            toolMenu={toolMenu}
          />
        ) : (
          <DataStreamRuntimeChat
            api={api}
            completePreparedRequest={completePreparedRequest}
            composerDraftCommand={composerDraftCommand}
            contextWindow={contextWindow}
            cumulativeUsage={cumulativeUsage}
            disabled={disabled}
            disabledReason={disabledReason}
            effectiveInputBudget={effectiveInputBudget}
            historyAdapter={historyAdapter}
            key={threadKey ? `data-stream:${threadKey}` : 'data-stream'}
            localLoadingState={localLoadingState}
            modelName={modelName}
            omSegment={omSegment}
            onModelChange={onModelChange}
            onProviderSettingsChange={onProviderSettingsChange}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onStreamActivity={onStreamActivity}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            prepareLocalModel={prepareLocalModel}
            {...(onUsage ? { onUsage } : {})}
            {...(onTogglePlanMode
              ? {
                  planMode: {
                    enabled: Boolean(planModeEnabled),
                    onToggle: onTogglePlanMode,
                    ...(onExitPlanMode ? { onExit: onExitPlanMode } : {}),
                  },
                }
              : {})}
            fileMentions={fileMentions}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onFileMentionQueryChange={onFileMentionQueryChange}
            pickerModels={pickerModels}
            pickerProviders={pickerProviders}
            prepareRequestData={prepareRequestData}
            providerGroups={groupedProviders}
            providerSettings={providerSettings}
            requestData={requestData}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            slashCommands={slashCommands}
            threadKey={threadKey}
            toolMenu={toolMenu}
          />
        )}
      </section>
    </AssistantDetailLevelProvider>
  );
};

// ===== Message Components =====

const UserMessage = () => {
  return (
    <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-3 [&:where(>*)]:col-start-2">
      <UserActionBar />

      <ExpandableMessageContent
        className="aui-user-message-content col-start-2 row-start-2 max-w-xl break-words rounded-2xl bg-muted px-4 py-2"
        testId="assistant-user-message-content"
      >
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: AssistantMessageText,
          }}
        />
      </ExpandableMessageContent>

      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    className="col-start-1 row-start-2 mt-2 mr-3 flex flex-col items-end"
    hideWhenRunning
  >
    <ActionBarPrimitive.Edit asChild>
      <TooltipIconButton aria-label="Edit message" tooltip="Edit">
        <PencilIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Edit>
  </ActionBarPrimitive.Root>
);

const EditComposer = () => (
  <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
    <ComposerPrimitive.Input className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none" />

    <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
      <ComposerPrimitive.Cancel asChild>
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
      </ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send asChild>
        <Button size="sm">Send</Button>
      </ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>
);

const AssistantMessage = () => {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-4">
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-2xl break-words text-foreground leading-7">
        {/* ChainOfThought takes control of ALL reasoning and tool-call parts
            (the library forbids a separate `tools` mapping alongside it), so
            tool rendering lives inside LocalChainOfThought. */}
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "ChainOfThought" key */
            ChainOfThought: LocalChainOfThought,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: AssistantMessageText,
          }}
        />
        <AssistantMessageError />
      </div>

      <AssistantActionBar />

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

export const ASSISTANT_ACTION_BAR_CLASSNAME =
  'col-start-3 row-start-2 -ml-1 flex gap-0.5 text-muted-foreground data-[floating]:absolute';
export const ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME = 'size-5';

const AssistantActionBar = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className={ASSISTANT_ACTION_BAR_CLASSNAME}
    hideWhenRunning
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton
        aria-label="Copy message"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Copy"
      >
        <MessagePrimitive.If copied>
          <CheckIcon className="size-3.5" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <CopyIcon className="size-3.5" />
        </MessagePrimitive.If>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton
        aria-label="Regenerate response"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        tooltip="Retry"
      >
        <RefreshCwIcon className="size-3.5" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);

const BranchPicker = ({ className }: { className?: string }) => (
  <BranchPickerPrimitive.Root
    className={`inline-flex items-center text-muted-foreground text-xs ${className ?? ''}`}
    hideWhenSingleBranch
  >
    <BranchPickerPrimitive.Previous asChild>
      <TooltipIconButton aria-label="Previous branch" tooltip="Previous">
        <ChevronLeftIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Previous>
    <span className="font-medium">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <TooltipIconButton aria-label="Next branch" tooltip="Next">
        <ChevronRightIcon className="size-4" />
      </TooltipIconButton>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);

const RUNTIME_LABELS: Record<ProviderRuntimeCategory, string> = {
  browser: 'Browser',
  gateway: 'Gateway',
  hosted: 'Hosted',
  local: 'Local',
};

interface ProviderModelOption {
  groupLabel: string;
  model: ProviderModelOptionConfig;
  provider: ProviderOptionConfig;
  value: string;
}

interface NormalizedProviderGroup {
  label: string;
  providers: Array<{
    provider: ProviderOptionConfig;
    models: ProviderModelOptionConfig[];
  }>;
  runtime: ProviderRuntimeCategory;
}

interface ProviderModelHeaderProps {
  groups: ProviderGroupConfig[];
  onModelChange?: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  selectedModel?: string | undefined;
  selectedProvider?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}

const ProviderModelHeader = ({
  groups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  toolMenu,
}: ProviderModelHeaderProps) => {
  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  const normalizedGroups = useMemo<NormalizedProviderGroup[]>(
    () =>
      groups
        .map((group) => {
          const providers = group.providers
            .map((provider) => ({
              models: provider.models.filter((model) => model.enabled),
              provider,
            }))
            .filter((entry) => entry.models.length > 0);
          if (providers.length === 0) {
            return null;
          }
          return {
            label: group.label ?? RUNTIME_LABELS[group.runtime],
            providers,
            runtime: group.runtime,
          };
        })
        .filter((group): group is NormalizedProviderGroup => group !== null),
    [groups]
  );

  const options = useMemo<ProviderModelOption[]>(
    () =>
      normalizedGroups.flatMap((group) =>
        group.providers.flatMap((entry) =>
          entry.models.map((model) => ({
            groupLabel: group.label,
            model,
            provider: entry.provider,
            value: `${entry.provider.id}::${model.id}`,
          }))
        )
      ),
    [normalizedGroups]
  );

  // Build a lookup map from model ID to provider ID for the ModelPicker callback
  const modelToProviderMap = useMemo(() => {
    const map = new Map<string, string>();
    if (pickerModels) {
      for (const model of pickerModels) {
        map.set(model.id, model.providerId);
      }
    }
    return map;
  }, [pickerModels]);

  // Handle ModelPicker selection - convert model ID to composite key
  const handleModelPickerChange = useCallback(
    (modelId: string | string[]) => {
      const id = Array.isArray(modelId) ? modelId[0] : modelId;
      if (!id) {
        return;
      }

      const providerId = modelToProviderMap.get(id);
      if (providerId) {
        // Construct composite key: "provider::model"
        onModelChange?.(`${providerId}::${id}`);
      }
    },
    [modelToProviderMap, onModelChange]
  );

  return (
    <div className="bs-composer-control-dock" data-testid="assistant-composer-controls">
      <div className="bs-composer-primary-controls">
        <div className="bs-composer-model-slot" data-testid="assistant-model-dropdown">
          <ModelPicker
            models={pickerModels}
            providers={pickerProviders}
            {...(modelName ? { value: modelName } : {})}
            className="bs-composer-model-picker h-8 rounded-full border-border/70 bg-background/85 text-xs"
            disabled={options.length === 0 || !onModelChange}
            mode="single"
            modelType="llm"
            onChange={handleModelPickerChange}
            placeholder={options.length === 0 ? 'No models enabled' : 'Select a model...'}
          />
        </div>
        <div className="bs-composer-controls-slot">
          <ControlsMenu
            modelName={modelName}
            onProviderSettingsChange={onProviderSettingsChange}
            providerSettings={providerSettings}
            selectedProvider={selectedProvider}
            toolMenu={toolMenu}
          />
        </div>
      </div>
      <div className="bs-composer-context-slot" />
    </div>
  );
};

export { ProviderSettingsPanel } from './provider-settings-panel';

AssistantUiPanel.displayName = 'AssistantUiPanel';
