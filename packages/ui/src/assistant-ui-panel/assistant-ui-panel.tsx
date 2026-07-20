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
  CONTEXT_BREAKDOWN_DATA_NAME,
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
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { cn } from '../lib/utils';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import {
  ApprovalActionChip,
  fromApprovalActionChipKey,
  readApprovalActionChipProps,
  toApprovalActionChipKey,
} from './approval-action-chip';
import { AssistantActivityGroup } from './assistant-activity-group';
import { ControlsMenu } from './assistant-controls-menu';
import { AssistantDetailLevelProvider } from './assistant-detail-level-context';
import {
  assistantEndpointLogger,
  resolveAssistantAuthHeaders,
  resolveAssistantEndpoint,
} from './assistant-endpoint';
import { AssistantMessageError } from './assistant-message-error';
import { AssistantMessageText, preloadMarkdownText } from './assistant-message-text';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import { AssistantRunEventProvider } from './assistant-run-event-context';
import { AssistantRunTimelineDataPart } from './assistant-run-timeline-data-part';
import {
  AssistantThinkingIndicator,
  BrainstrikeThinkingMark,
} from './assistant-thinking-indicator';
import { AssistantToolApprovalNotice } from './assistant-tool-approval-notice';
import { AssistantToolSuspendNotice, PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { createAssistantImageAttachmentAdapter } from './attachment-adapter';
import { BudgetGuardrailControl, useBudgetSendGate } from './budget-guardrail-control';
import { CheckpointTurnRevert } from './checkpoint-turn-revert';
import { ComposerAttachmentsBar, UserMessageAttachments } from './composer-attachments';
import type { ComposerDraftCommandBridgeProps } from './composer-draft-command';
import { type ComposerDraftCommand, ComposerDraftCommandBridge } from './composer-draft-command';
import { type ComposerAttachmentsAvailability, ComposerInputWithTriggers } from './composer-input';
import { ComposerModelMenu, modelIdFromCompositeKey } from './composer-model-menu';
import { OperatingRootChip, type OperatingRootInfo } from './operating-root-chip';

export type { ComposerAttachmentsAvailability } from './composer-input';

import { ComposerMentionPopover } from './composer-mention-popover';
import { ComposerTriggerPopover } from './composer-trigger-popover';
import {
  type CumulativeUsageDisplay,
  type OmMeterState,
  ThreadContextMeter,
} from './context-usage-meter';
import { type AssistantUsage, useBrainstrikeDataStreamRuntime } from './data-stream-runtime';
import { ExpandableMessageContent } from './expandable-message-content';
import { buildFileMentionAdapter, type FileMention } from './file-mentions';
import { ComposerRunControls, FollowUpQueueBridge, FollowUpQueueChips } from './follow-up-queue';
import { LocalModelStatus } from './local-model-status';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { RunLifecycleNotificationBridge } from './run-lifecycle-notifications';
import { RunVerdictControl } from './run-verdict-control';
import { ShellOutputProvider } from './shell-output-context';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from './slash-commands';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS, TodoProgress } from './todo-progress';
import { ToolDurationProvider } from './tool-duration-context';
import { TooltipIconButton } from './tooltip-icon-button';
import { useChainActivityDerivations } from './use-chain-activity-derivations';
import { type LocalModelLoadingState, useLocalModelLoading } from './use-local-model-loading';

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

// Live shell-output slices are consumed by the tool card (via the incremental
// shell-output accumulator + ShellOutputProvider), NOT rendered inline in the
// message flow — register a null renderer so the transient data parts never
// surface as stray elements.
const assistantShellOutputDataUI = {
  name: SHELL_OUTPUT_DATA_NAME,
  render: () => null,
} satisfies AssistantDataUIProps;

// The run-start prompt breakdown is consumed by the onContextBreakdown tap
// (buildContextBreakdownTap in data-stream-runtime.ts) and rendered in the
// Context Usage popover, NOT inline in the message flow — register a null
// renderer so the transient data part never surfaces as a stray element
// (mirrors assistantShellOutputDataUI above).
const assistantContextBreakdownDataUI = {
  name: CONTEXT_BREAKDOWN_DATA_NAME,
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
export type { ComposerDraftCommand } from './composer-draft-command';

import type {
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';

export interface AssistantUiPanelProps extends ComposerDraftCommandBridgeProps {
  /** Models for the ModelPicker component */
  /**
   * Composer image-attachment availability, resolved by the app-shell
   * wrapper. Absent renders no attachment affordance and registers no
   * attachment adapter (provider gate: the text-only built-in local
   * provider); 'disabled' renders a visibly disabled attach button with the
   * reason (per-model vision gate) while keeping the adapter + preview strip
   * alive for already-staged attachments; 'enabled' activates attach, paste,
   * and the preview strip.
   */
  attachmentsAvailability?: ComposerAttachmentsAvailability;
  className?: string;
  completePreparedRequest?: (
    requestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
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
  /**
   * Called with the RAW payload of each run-start `brainstrike.context-breakdown`
   * data part (transient prompt breakdown). Hosted/data-stream transport only —
   * the in-renderer local runtime has no breakdown channel (capability-absent),
   * so the callback is simply never wired there. The app parses the payload
   * with the contract guard (malformed → { invalid: true }) and records it in
   * the context usage store; same seam shape as onUsage.
   */
  onContextBreakdown?: (data: unknown) => void;
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
  /** Mid-run steer transport (BST-588); absent = queue-only (web/local). */
  onSteerActiveRun?: () => Promise<boolean>;
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
  onUsage?: (usage: AssistantUsage) => void;
  /**
   * The assistant's operating root (MAIN root — activeRootIds[0]), shown as a
   * compact chip above the composer. App-shell passes it ONLY when 2+
   * workspace roots are mounted; absent renders no chip (single-root/web).
   */
  operatingRoot?: OperatingRootInfo;
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  /** Current persisted plan-mode state; drives the composer toggle's pressed look. */
  planModeEnabled?: boolean;
  prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
  providerGroups?: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  providers?: ProviderConfig[];
  /**
   * Recently selected composite model keys ("provider::model"), newest first.
   * Already filtered to currently valid options by the app-shell wrapper.
   */
  recentModels?: readonly string[];
  requestBodyLimitBytes?: number;
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

const LocalReasoningPart = () => {
  useMessagePartReasoning();

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
      <p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Thinking
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
    return isContinuation ? 'Show additional thinking' : 'Show thinking';
  }
  return isContinuation ? 'Hide additional thinking' : 'Hide thinking';
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
          {isContinuation ? null : <span className="truncate">Thinking</span>}
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

  const messageId = useAuiState((state) => (state.message as { id?: string }).id ?? '');
  // Per-turn derivations with context-value stability — see the hook's doc.
  const { activityFallbackMs, shellOutputs, taskList, toolActivity, toolDurations } =
    useChainActivityDerivations(messageParts, messageId);

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
    <ChainOfThoughtPrimitive.Root className="bs-chain-of-thought mb-2 block max-w-2xl">
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
  useAssistantDataUI(assistantContextBreakdownDataUI);

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
interface ChatThreadProps extends ComposerDraftCommandBridgeProps {
  /** Composer image-attachment availability (attach button, paste, previews). */
  attachmentsAvailability?: ComposerAttachmentsAvailability | undefined;
  completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: 'cancelled' | 'completed' | 'failed',
        error?: string
      ) => Promise<void> | void)
    | undefined;
  contextWindow?: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  disabled: boolean;
  disabledReason: string | undefined;
  effectiveInputBudget?: number | undefined;
  fileMentions: readonly FileMention[];
  loadLocalLlmBackend?: LocalLlmBackendFactory | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  omSegment?: OmMeterState | undefined;
  /** Data-stream transport only; never passed to the local runtime path. */
  onContextBreakdown?: ((data: unknown) => void) | undefined;
  onFileMentionQueryChange: ((query: string) => void) | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  /** Mid-run steer transport (BST-588); absent = queue-only composer. */
  onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  onStreamActivity?: (() => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  onUsage?: ((usage: AssistantUsage) => void) | undefined;
  /** Assistant operating root chip (multi-root only); absent → no chip. */
  operatingRoot?: OperatingRootInfo | undefined;
  pickerModels: ModelPickerModel[];
  /** Composer plan-mode toggle; absent → no toggle rendered. */
  planMode?: { enabled: boolean; onExit?: () => void; onToggle: () => void } | undefined;
  prepareRequestData?: (() => Promise<Record<string, unknown> | undefined>) | undefined;
  providerGroups: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  recentModels: readonly string[] | undefined;
  requestBodyLimitBytes?: number | undefined;
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
  providerSettings,
  recentModels,
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
  operatingRoot,
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
          {...(operatingRoot ? { operatingRoot } : {})}
          pickerModels={pickerModels}
          {...(planMode ? { planMode } : {})}
          providerGroups={providerGroups}
          providerSettings={providerSettings}
          recentModels={recentModels}
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
  providerSettings,
  recentModels,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  onContextBreakdown,
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
  authHeaders,
  completePreparedRequest,
  historyAdapter,
  requestBodyLimitBytes,
  requestData,
  prepareRequestData,
  prepareLocalModel,
  modelName,
  slashCommands,
  fileMentions,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  onSteerActiveRun,
  operatingRoot,
  planMode,
  attachmentsAvailability,
  toolMenu,
  threadKey,
}: ChatThreadProps & {
  api: string;
  authHeaders?: (() => Promise<Record<string, string>>) | undefined;
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

  // Stable adapter instance: recreating it per render would reset composer
  // attachment state. Keyed on availability PRESENCE (not the enabled state,
  // and not the object identity): the adapter must survive an
  // enabled→disabled model switch so attachments staged under a vision model
  // stay removable/sendable — assistant-ui's composer wipes text + staged
  // attachments and then throws an unhandled "Attachments are not supported"
  // rejection if Send runs with no adapter. The 'disabled' vision-gate state
  // blocks NEW adds through the disabled attach button and the absent paste
  // frame (composer-input.tsx) instead; a sent-anyway staged image surfaces
  // the documented visible provider error. Absent availability (provider
  // gate) registers no adapter, so adds are rejected loudly, never silently
  // accepted.
  const attachmentsPresent = attachmentsAvailability !== undefined;
  const attachmentsAdapter = useMemo(
    () => (attachmentsPresent ? createAssistantImageAttachmentAdapter() : undefined),
    [attachmentsPresent]
  );
  const runtimeAdapters =
    historyAdapter || attachmentsAdapter
      ? {
          adapters: {
            ...(attachmentsAdapter ? { attachments: attachmentsAdapter } : {}),
            ...(historyAdapter ? { history: historyAdapter } : {}),
          },
        }
      : {};
  const runtime = useBrainstrikeDataStreamRuntime({
    api,
    ...(authHeaders === undefined ? {} : { headers: authHeaders }),
    ...runtimeAdapters,
    ...(requestBodyLimitBytes === undefined ? {} : { requestBodyLimitBytes }),
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
    ...(onContextBreakdown ? { onContextBreakdown } : {}),
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
            {...(onSteerActiveRun ? { onSteerActiveRun } : {})}
            {...(operatingRoot ? { operatingRoot } : {})}
            pickerModels={pickerModels}
            {...(planMode ? { planMode } : {})}
            {...(attachmentsAvailability ? { attachmentsAvailability } : {})}
            providerGroups={providerGroups}
            providerSettings={providerSettings}
            recentModels={recentModels}
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
  providerSettings,
  recentModels,
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
  onSteerActiveRun,
  operatingRoot,
  planMode,
  attachmentsAvailability,
  threadKey,
  toolMenu,
}: {
  composerDraftCommand?: ComposerDraftCommand | undefined;
  contextWindow?: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  omSegment?: OmMeterState | undefined;
  effectiveInputBudget?: number | undefined;
  attachmentsAvailability?: ComposerAttachmentsAvailability | undefined;
  onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  operatingRoot?: OperatingRootInfo | undefined;
  planMode?: { enabled: boolean; onExit?: () => void; onToggle: () => void } | undefined;
  providerGroups: ProviderGroupConfig[];
  hasGroupedProviders: boolean;
  pickerModels: ModelPickerModel[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  recentModels: readonly string[] | undefined;
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
      <ComposerDraftCommandBridge
        composerDraftCommand={composerDraftCommand}
        onComposerDraftCommandApplied={onComposerDraftCommandApplied}
        onComposerTextChange={onComposerTextChange}
      />
      <RunLifecycleNotificationBridge
        {...(onRunFailed ? { onRunFailed } : {})}
        {...(onRunFinished ? { onRunFinished } : {})}
        {...(onToolApprovalRequired ? { onToolApprovalRequired } : {})}
        {...(threadKey ? { threadKey } : {})}
      />
      <FollowUpQueueBridge threadKey={threadKey} />
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
        <AssistantRunEventProvider>
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
        </AssistantRunEventProvider>
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
        {/* Multi-root operating-root chip ("in {main root}") — its own module,
            a SIBLING at the top of the composer stack (never nested inside
            ThreadContextMeter, which is being reworked separately). Renders
            nothing unless app-shell passes operatingRoot (2+ roots). */}
        <OperatingRootChip operatingRoot={operatingRoot} />
        <ThreadContextMeter
          contextWindow={contextWindow}
          cumulativeUsage={cumulativeUsage}
          effectiveInputBudget={effectiveInputBudget}
          omSegment={omSegment}
          threadKey={threadKey}
        />
        {/* Last-24h budget burn-down + over-cap send notice (owned module,
            budget-guardrail-control.tsx); renders nothing without a binding. */}
        <BudgetGuardrailControl />
        {localLoadingState && <LocalModelStatus state={localLoadingState} />}
        <FollowUpQueueChips threadKey={threadKey} />
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
          {/* Mounted on PRESENCE (enabled or disabled): a staged image keeps
              its preview + Remove button after a switch to a text-only model. */}
          {attachmentsAvailability ? <ComposerAttachmentsBar /> : null}
          <ComposerInputWithTriggers
            isComposerDisabled={isComposerDisabled}
            queueControl={
              <ComposerRunControls onSteerActiveRun={onSteerActiveRun} threadKey={threadKey} />
            }
            {...(attachmentsAvailability ? { attachmentsAvailability } : {})}
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
              providerSettings={providerSettings}
              recentModels={recentModels}
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
/** Initial API URL for the data stream runtime (hosted providers). */
function resolveInitialAssistantApi(): string {
  if (typeof window === 'undefined') {
    return '/api/assistant';
  }
  return window.assistant?.url ? `${window.assistant.url}/assistant` : '/api/assistant';
}

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
  providerSettings,
  recentModels,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  requestData,
  requestBodyLimitBytes,
  prepareRequestData,
  onModelChange,
  onExitPlanMode,
  onRunFailed,
  onRunFinished,
  onStreamActivity,
  onThreadRunStart,
  onTogglePlanMode,
  onToolApprovalRequired,
  onContextBreakdown,
  onUsage,
  attachmentsAvailability,
  operatingRoot,
  planModeEnabled,
  slashCommands = EMPTY_SLASH_COMMANDS,
  fileMentions = EMPTY_FILE_MENTIONS,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  onSteerActiveRun,
  toolMenu,
  disabled = false,
  disabledReason,
  historyAdapter,
  loadLocalLlmBackend,
  localChatTransport = 'local-runtime',
  threadKey,
}: AssistantUiPanelProps) => {
  // API URL for the runtime; auth headers resolve per-request (assistant-endpoint.ts).
  const [api, setApi] = useState<string>(resolveInitialAssistantApi);

  useEffect(() => {
    void preloadMarkdownText();
    let ignore = false;
    resolveAssistantEndpoint()
      .then((endpoint) => {
        if (!ignore && endpoint) {
          setApi(endpoint.api);
        }
      })
      .catch((error) => {
        // A bridge that exists but errors means a broken assistant — say so.
        assistantEndpointLogger.error('Failed to resolve assistant endpoint', { error });
      });
    return () => {
      ignore = true;
    };
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
            operatingRoot={operatingRoot}
            {...(onUsage ? { onUsage } : {})}
            fileMentions={fileMentions}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onFileMentionQueryChange={onFileMentionQueryChange}
            pickerModels={pickerModels}
            prepareRequestData={prepareRequestData}
            providerGroups={groupedProviders}
            providerSettings={providerSettings}
            recentModels={recentModels}
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
            attachmentsAvailability={attachmentsAvailability}
            authHeaders={resolveAssistantAuthHeaders}
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
            operatingRoot={operatingRoot}
            prepareLocalModel={prepareLocalModel}
            {...(onContextBreakdown ? { onContextBreakdown } : {})}
            onSteerActiveRun={onSteerActiveRun}
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
            prepareRequestData={prepareRequestData}
            providerGroups={groupedProviders}
            providerSettings={providerSettings}
            recentModels={recentModels}
            requestBodyLimitBytes={requestBodyLimitBytes}
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
  // Approval action messages ("Approved <tool>.") are transport bookkeeping —
  // kept in thread state (outcome locking + resume runConfig ride on them,
  // and they are excluded from every outbound payload at the transport seam)
  // but rendered as a compact outcome chip, never a prompt bubble. The
  // selector returns a stable string key (same pattern as the approval
  // notice's outcome key) so the store snapshot stays referentially stable.
  const approvalChipKey = useAuiState((state) =>
    toApprovalActionChipKey(readApprovalActionChipProps(state.message))
  );
  if (approvalChipKey) {
    const chipProps = fromApprovalActionChipKey(approvalChipKey);
    return (
      <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-3 [&:where(>*)]:col-start-2">
        <ApprovalActionChip {...chipProps} />
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-2 [&:where(>*)]:col-start-2">
      <UserActionBar />

      <ExpandableMessageContent
        className="aui-user-message-content col-start-2 row-start-2 max-w-xl break-words rounded-2xl bg-muted px-4 py-2"
        testId="assistant-user-message-content"
      >
        <UserMessageAttachments />
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

// Exported (rather than kept module-private like AssistantActionBar) so
// tests can mount it directly against a real assistant-ui local runtime --
// see __tests__/user-action-bar-copy.test.tsx.
export const UserActionBar = () => {
  const aui = useAui();
  const { copyToClipboard, isCopied, isFailed } = useCopyToClipboard();

  // Routed through the shared clipboard service (useCopyToClipboard), NOT
  // ActionBarPrimitive.Copy's built-in navigator.clipboard.writeText --
  // that call swallows write rejections, so a broken Electron bridge would
  // silently do nothing (no-silent-fallbacks rule). aui.message().getCopyText()
  // is the same message-text extraction assistant-ui's own copy hook uses
  // internally (join of the message's text parts).
  const onCopy = () => {
    if (isCopied) {
      return;
    }
    copyToClipboard(aui.message().getCopyText());
  };

  let tooltip = 'Copy';
  if (isCopied) {
    tooltip = 'Copied!';
  } else if (isFailed) {
    tooltip = 'Copy failed';
  }

  let copyIcon: ReactNode;
  if (isCopied) {
    copyIcon = <CheckIcon className="size-4" />;
  } else if (isFailed) {
    copyIcon = <CopyIcon className="size-4 text-destructive" />;
  } else {
    copyIcon = <CopyIcon className="size-4" />;
  }

  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      className="col-start-1 row-start-2 mt-2 mr-3 flex flex-col items-end"
      hideWhenRunning
    >
      <TooltipIconButton aria-label="Copy message" onClick={onCopy} tooltip={tooltip}>
        {copyIcon}
      </TooltipIconButton>
      {/* Proactively announce a broken clipboard to screen readers -- the
          tooltip alone is not announced (no-silent-fallbacks). Mirrors
          CodeBlockHeader / CopyTextButton. */}
      <span aria-live="polite" className="sr-only" role="status">
        {isFailed ? 'Copy failed' : null}
      </span>
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton aria-label="Edit message" tooltip="Edit">
          <PencilIcon className="size-4" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer = () => {
  // Editing a past user message RE-SENDS it, so the last-24h budget gate must
  // cover this path too — otherwise edit-resend silently bypasses the cap. The
  // gate is never silent: the BudgetGuardrailControl notice in the composer
  // shell explains the block and offers the explicit session override.
  const budgetSendBlocked = useBudgetSendGate();
  return (
    <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
      {/* disabled mirrors ComposerInputRow: the Input submits on Enter, so a
          gate on the Send button alone leaves a keyboard bypass (review #1714). */}
      <ComposerPrimitive.Input
        className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none"
        disabled={budgetSendBlocked}
      />

      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <Button size="sm" variant="ghost">
            Cancel
          </Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button disabled={budgetSendBlocked} size="sm">
            Send
          </Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
};

const AssistantMessage = () => {
  // Bottom rhythm comes from overrides.css (.aui-*-message-root rules).
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-2">
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-2xl break-words text-foreground leading-6">
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
        {/* Turn-level "Revert all edits" footer — renders only on desktop turns
            that made ≥1 still-revertible file edit; null everywhere else. */}
        <CheckpointTurnRevert />
        {/* Per-run 👍/👎 verdict (Task Ledger) — renders once per finished run
            on its terminal message leg; null without a verdict provider. */}
        <RunVerdictControl />
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

interface ProviderModelHeaderProps {
  groups: ProviderGroupConfig[];
  onModelChange?: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  pickerModels: ModelPickerModel[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  recentModels?: readonly string[] | undefined;
  selectedModel?: string | undefined;
  selectedProvider?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
}

const ProviderModelHeader = ({
  groups,
  pickerModels,
  providerSettings,
  onProviderSettingsChange,
  recentModels,
  selectedProvider,
  selectedModel,
  onModelChange,
  toolMenu,
}: ProviderModelHeaderProps) => {
  // Bare model id for the Output & Limits menu (display/model-scoped
  // constraints only — selection itself stays composite end-to-end).
  const modelName = modelIdFromCompositeKey(selectedModel);

  return (
    <div className="bs-composer-control-dock" data-testid="assistant-composer-controls">
      <div className="bs-composer-primary-controls">
        <div className="bs-composer-model-slot" data-testid="assistant-model-dropdown">
          <ComposerModelMenu
            onModelChange={onModelChange}
            onProviderSettingsChange={onProviderSettingsChange}
            pickerModels={pickerModels}
            providerGroups={groups}
            providerSettings={providerSettings}
            recentModels={recentModels}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
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
    </div>
  );
};

export { ProviderSettingsPanel } from './provider-settings-panel';

AssistantUiPanel.displayName = 'AssistantUiPanel';
