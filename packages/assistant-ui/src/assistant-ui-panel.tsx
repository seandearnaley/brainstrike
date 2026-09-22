import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useLocalRuntime,
  // Aliased to a `use`-prefixed name so React Fast Refresh (Vite dev) recognizes
  // it as a hook. Its detection keys on the `use` prefix; an `unstable_use…` call
  // site is missed, so React's real hook count (this hook calls useMemo) exceeds the
  // Fast Refresh signature and throws "Rendered fewer hooks" -- crashing ChatThreadUI
  // + looping the error boundary in dev. Dev-only; prod/tests (no Fast Refresh) were fine.
  unstable_useSlashCommandAdapter as useSlashCommandAdapter,
} from '@assistant-ui/react';
import type {
  AssistantRunEvent,
  AssistantToolApprovalRequest,
  AssistantUiThreadHistoryAdapter,
  LocalLlmBackendFactory,
  OpenRouterModelMetadataLookup,
} from '@brainstrike/assistant-contract';
import { type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnsweredApprovalsProvider } from './answered-approvals-index';
import { ApprovalRanksProvider } from './approval-presentation-context';
import { ApprovalQueueStrip } from './approval-queue-strip';
import { AssistantDataRendererRegistration } from './assistant-data-renderer-registration';
import type { AssistantStreamCallbacks } from './assistant-stream-callbacks';
import { SubagentInvocationIndexProvider } from './subagent-invocation-index';
import { useAssistantEndpointApi } from './use-assistant-endpoint-api';
import { useAssistantThreadRuntimeAdapters } from './use-assistant-thread-runtime-adapters';
import '@assistant-ui/styles/index.css';
import './overrides.css';
import type { ModelPickerModel, ModelPickerProvider } from '@brainstrike/ui';
import { Button, cn } from '@brainstrike/ui';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { AssistantActionBar } from './assistant-action-bar';
import { AssistantActivityParts } from './assistant-activity-parts';
import { ControlsMenu } from './assistant-controls-menu';
import { resolveAssistantAuthHeaders } from './assistant-endpoint';
import { AssistantMessageError } from './assistant-message-error';
import { AssistantMessageText, preloadMarkdownText } from './assistant-message-text';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import {
  type ThreadMessageComponents,
  ThreadMessagesRegion,
  ThreadScrollRegion,
  ThreadScrollToBottom,
} from './assistant-thread-messages';
import { PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { BranchPicker } from './branch-picker';
import { BudgetGuardrailControl, useBudgetSendGate } from './budget-guardrail-control';
import { ChangesReviewLink } from './changes-review-link';
import { CheckpointTurnRevert } from './checkpoint-turn-revert';
import { CompactionSummaryCard } from './compaction-summary-card';
import {
  isCompactionSummaryMessage,
  readCompactionSummaryPayload,
} from './compaction-summary-message';
import { ComposerAttachmentsBar } from './composer-attachments';
import type { ComposerDraftCommandBridgeProps } from './composer-draft-command';
import { type ComposerDraftCommand, ComposerDraftCommandBridge } from './composer-draft-command';
import { ComposerEffortControl } from './composer-effort-control';
import { type ComposerAttachmentsAvailability, ComposerInputWithTriggers } from './composer-input';
import { ComposerModelPicker, modelIdFromCompositeKey } from './composer-model-picker';
import { CopyDebugBundleButton } from './copy-debug-bundle-button';
import { RewindComposerBridge } from './message-rewind-action';
import { MetadataProviders } from './openrouter-model-metadata-context';
import { ThreadDebugPackButton } from './thread-debug-pack-button';
import { UserMessage } from './user-message';

export type { ComposerAttachmentsAvailability } from './composer-input';
// Re-exported for the suites that mount these against a real runtime
// (user-action-bar-copy, assistant-chat-polish.browser) — extraction moved the
// source module, not the public import path.
export { USER_ACTION_BAR_CLASSNAME, UserActionBar, UserMessage } from './user-message';

import { ComposerMentionPopover } from './composer-mention-popover';
import { ComposerTriggerPopover } from './composer-trigger-popover';
import {
  type CumulativeUsageDisplay,
  type OmMeterState,
  ThreadContextMeter,
} from './context-usage-meter';
import {
  type AssistantUsage,
  type PrepareRequestBodyContext,
  useBrainstrikeDataStreamRuntime,
} from './data-stream-runtime';
import { buildFileMentionAdapter, type FileMention } from './file-mentions';
import { ComposerRunControls, FollowUpQueueBridge, FollowUpQueueChips } from './follow-up-queue';
import { LocalModelStatus } from './local-model-status';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { RunLifecycleNotificationBridge } from './run-lifecycle-notifications';
import { RunVerdictControl } from './run-verdict-control';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from './slash-commands';
import { ThreadScrollFollowProvider } from './thread-scroll-follow';
import { useAssistantServerRunSession } from './use-assistant-server-run-session';
import { type LocalModelLoadingState, useLocalModelLoading } from './use-local-model-loading';

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
// `packages/app-state` share a single canonical definition. They are
// re-exported here to keep the existing public surface of the
// `@brainstrike/assistant-ui` entry point stable for consumers that
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

export interface AssistantUiPanelProps
  extends ComposerDraftCommandBridgeProps,
    AssistantStreamCallbacks {
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
    error?: string,
    hostOwnsRun?: boolean
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
  historyAdapter?: AssistantUiThreadHistoryAdapter;
  /**
   * Re-hydration counter. `historyAdapter.load()` runs ONCE per runtime mount,
   * so a durable change made OUTSIDE the panel — Conversation Rewind hiding a
   * suffix of the thread, or its redo putting one back — is invisible to a
   * mounted runtime. Bumping this remounts the data-stream runtime, which
   * re-runs hydration against the (now tombstone-filtered) history query.
   *
   * SEPARATE FROM `threadKey` ON PURPOSE. `threadKey` identifies the CONVERSATION
   * and keys per-thread state that must survive a rewind (the follow-up queue,
   * `ActiveThreadKeyContext`, the viewport store's pinnedness). This keys only
   * the runtime whose history it invalidates. Defaults to 0; a caller with no
   * out-of-band mutations never touches it.
   */
  historyGeneration?: number;
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
  onProviderSettingsValidationChange?: (reason: string | undefined) => void;
  /**
   * Reports a `run.failed` run event exactly once (deduped by event id).
   * Only ever fires for the Mastra-loop transport (hosted providers / desktop
   * local-via-data-stream) — the in-renderer local runtime has no run events.
   */
  /**
   * Live, in-run activity that can have changed files on disk — see
   * `RunLifecycleNotificationCallbacks.onRunEditActivity`.
   */
  onRunEditActivity?: (event: AssistantRunEvent) => void;
  onRunFailed?: (event: AssistantRunEvent) => void;
  /** Reports a `run.finished` run event exactly once (deduped by event id). */
  onRunFinished?: (event: AssistantRunEvent) => void;
  /** Register this runtime with its owning workspace; cleanup follows runtime disposal. */
  onRuntimeReady?: ((runtime: AssistantRuntime) => undefined | (() => void)) | undefined;
  /** Mid-run steer transport (BST-588); absent = queue-only (web/local). */
  onSteerActiveRun?: () => Promise<boolean>;
  /**
   * Called with each `run.step.finished` event's billed step usage while a run
   * streams (BST-953 live tick). The app accumulates steps into the live
   * thread-total readout and clears the sum once durable usage lands.
   */
  onStepUsage?: (step: { inputTokens: number; outputTokens: number }) => void;
  /**
   * A settled root Stop cancelled a pause this thread still showed, so the
   * data-stream runtime is about to REMOUNT and re-read history. Called
   * immediately after that bump and in the SAME React batch, while the live
   * composer still exists, so the host can carry its draft into the new mount
   * through its own thread-scoped channel (app-shell's composer command
   * store) and the command reaches the replacement rather than the composer
   * being discarded. Not called when the bump cannot take effect (this panel
   * has since moved to another thread). The panel keeps no draft state of its
   * own; a host that wires nothing keeps today's behaviour.
   */
  onStopReread?: () => void;
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
  openRouterModelMetadataLookup?: OpenRouterModelMetadataLookup | undefined;
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  /** Current persisted plan-mode state; drives the composer toggle's pressed look. */
  planModeEnabled?: boolean;
  prepareRequestData?: (
    abortSignal?: AbortSignal,
    turnAnchorMessageId?: string | null,
    runConfig?: unknown
  ) => Promise<Record<string, unknown> | undefined>;
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
  /**
   * Composer workspace bar (folder · branch) SLOT. App-shell renders the bar
   * host and passes the element; absent = no bar (storybook / bare embeds).
   *
   * A ReactNode, deliberately NOT `WorkspaceBarProps`: the bar's state comes
   * from two live-refresh subscriptions, and composing its props in app-shell's
   * panel wrapper made every git push re-render that ~1800-line component.
   * Owning the subscriptions in a small app-shell host and handing this package
   * the finished element keeps assistant-ui store-free AND keeps the re-render
   * scoped to the bar. `WorkspaceBar` + its prop types stay exported for the
   * host to use.
   */
  workspaceBar?: ReactNode;
}

export type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';

// Stable empty default for the optional slashCommands prop. A literal `[]`
// default would create a new array each render, breaking memoization in the
// adapter/icon-map derivations downstream (react-doctor: empty default prop).
const EMPTY_SLASH_COMMANDS: readonly SlashCommand[] = [];

// Stable empty default for the optional fileMentions prop (same memoization
// rationale as EMPTY_SLASH_COMMANDS — a literal `[]` would churn the adapter).
const EMPTY_FILE_MENTIONS: readonly FileMention[] = [];

// Shared props for inner chat components
interface ChatThreadProps extends ComposerDraftCommandBridgeProps, AssistantStreamCallbacks {
  /** Composer image-attachment availability (attach button, paste, previews). */
  attachmentsAvailability?: ComposerAttachmentsAvailability | undefined;
  completePreparedRequest?:
    | ((
        requestData: Record<string, unknown> | undefined,
        status: 'cancelled' | 'completed' | 'failed',
        error?: string,
        hostOwnsRun?: boolean
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
  onFileMentionQueryChange: ((query: string) => void) | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  onRunEditActivity?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  onRuntimeReady?: AssistantUiPanelProps['onRuntimeReady'];
  /** Mid-run steer transport (BST-588); absent = queue-only composer. */
  onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  /** Data-stream transport only (BST-953 live tick); same gating as onContextBreakdown. */
  onStepUsage?: ((step: { inputTokens: number; outputTokens: number }) => void) | undefined;
  onStreamActivity?: (() => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  onUsage?: ((usage: AssistantUsage) => void) | undefined;
  pickerModels: ModelPickerModel[];
  /** Composer plan-mode toggle; absent → no toggle rendered. */
  planMode?: { enabled: boolean; onExit?: () => void; onToggle: () => void } | undefined;
  prepareRequestData?:
    | ((
        abortSignal?: AbortSignal,
        turnAnchorMessageId?: string | null,
        runConfig?: unknown
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined;
  providerGroups: ProviderGroupConfig[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  recentModels: readonly string[] | undefined;
  requestBodyLimitBytes?: number | undefined;
  requestData?: Record<string, unknown> | undefined;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  slashCommands: readonly SlashCommand[];
  toolMenu?: AssistantToolMenuConfig | undefined;
  /** Composer workspace bar (folder · branch) slot; absent → no bar. */
  workspaceBar?: ReactNode | undefined;
}

/**
 * Inner component for local runtime (browser-based inference).
 * Uses useLocalRuntime with LocalLlmBackend via transformers.js.
 */
const LocalRuntimeChat = ({
  onRuntimeReady,
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
  onRunEditActivity,
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
  workspaceBar,
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
  useEffect(() => onRuntimeReady?.(runtime), [onRuntimeReady, runtime]);

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
          onRunEditActivity={onRunEditActivity}
          onRunFailed={onRunFailed}
          onRunFinished={onRunFinished}
          onThreadRunStart={onThreadRunStart}
          onToolApprovalRequired={onToolApprovalRequired}
          {...(workspaceBar ? { workspaceBar } : {})}
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
  onRuntimeReady,
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
  onChildRunUsage,
  onDelegatedConversation,
  onStepUsage,
  onRunEditActivity,
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
  onPausesCancelled,
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
  workspaceBar,
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
        error?: string,
        hostOwnsRun?: boolean
      ) => Promise<void> | void)
    | undefined;
  historyAdapter: AssistantUiThreadHistoryAdapter | undefined;
  /** A settled root Stop cancelled a pause this runtime still shows: re-read history. */
  onPausesCancelled: () => void;
  requestData: Record<string, unknown> | undefined;
  prepareRequestData?:
    | ((
        abortSignal?: AbortSignal,
        turnAnchorMessageId?: string | null,
        runConfig?: unknown
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined;
  /** Pre-request hook: warms the built-in local model (with progress UI) before streaming. */
  prepareLocalModel?: ((abortSignal?: AbortSignal) => Promise<void>) | undefined;
  modelName: string | undefined;
  threadKey?: string | undefined;
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);
  const serverRunSession = useAssistantServerRunSession({
    api,
    authHeaders,
    completePreparedRequest,
    onPausesCancelled,
    prepareLocalModel,
    prepareRequestData,
    threadKey,
  });

  const runtimeAdapters = useAssistantThreadRuntimeAdapters(
    historyAdapter,
    attachmentsAvailability !== undefined
  );
  const runtime = useBrainstrikeDataStreamRuntime({
    ...(serverRunSession.activeRunSession
      ? { activeRunSession: serverRunSession.activeRunSession }
      : {}),
    api,
    ...(authHeaders === undefined ? {} : { headers: authHeaders }),
    ...runtimeAdapters,
    ...(requestBodyLimitBytes === undefined ? {} : { requestBodyLimitBytes }),
    ...(serverRunSession.prepareRequestWarmup
      ? { prepareRequestWarmup: serverRunSession.prepareRequestWarmup }
      : {}),
    body: async (abortSignal: AbortSignal, context?: PrepareRequestBodyContext) => {
      const preparedRequestData = await serverRunSession.prepareRequest(
        abortSignal,
        // Absent context (a caller predating the BST-1163 signature, incl.
        // direct test invocation) is an honest "no anchor known", never a
        // fabricated id.
        context?.turnAnchorMessageId ?? null,
        context?.runConfig
      );
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
    onCancel: serverRunSession.onCancel,
    onError: serverRunSession.onError,
    onFinish: serverRunSession.onFinish,
    onReplayError: serverRunSession.onReplayError,
    onResponse: serverRunSession.onResponse,
    ...(serverRunSession.resumeApi ? { resumeApi: serverRunSession.resumeApi } : {}),
    replayRetryToken: serverRunSession.replayRetryToken,
    ...(onContextBreakdown ? { onContextBreakdown } : {}),
    ...(onChildRunUsage ? { onChildRunUsage } : {}),
    onDelegatedConversation,
    ...(onStepUsage ? { onStepUsage } : {}),
    ...(onUsage ? { onUsage } : {}),
  });

  useEffect(() => onRuntimeReady?.(runtime), [onRuntimeReady, runtime]);

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
            onRunEditActivity={onRunEditActivity}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            {...(onSteerActiveRun ? { onSteerActiveRun } : {})}
            {...(workspaceBar ? { workspaceBar } : {})}
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
 * The active thread's id (assistant-ui's own `ThreadState` carries no id —
 * see `@assistant-ui/core`'s `store/scopes/thread.ts` — so it is not
 * reachable from `useAuiState` inside a message). `ChatThreadUI` already
 * receives it as `threadKey` (app-shell's `selectedMemoryThreadId`, threaded
 * down as a React prop from `assistant-ui-panel-wrapper.tsx`); this context
 * re-publishes that same value for descendants rendered by assistant-ui
 * itself (e.g. `AssistantMessage`, which the library instantiates with no
 * props of its own) — currently only `ChangesReviewLink`'s
 * `openChangesForRun(runId, threadId)` call needs it.
 */

/**
 * Shared UI component for the chat thread.
 * Extracted to avoid duplication between local and data stream runtimes.
 */
export const ChatThreadUI = ({
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
  onRunEditActivity,
  onRunFailed,
  onRunFinished,
  onThreadRunStart,
  onToolApprovalRequired,
  isComposerDisabled,
  hideDefaultCancel,
  disabledReason,
  localLoadingState,
  slashCommands,
  fileMentions,
  onFileMentionQueryChange,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  onSteerActiveRun,
  workspaceBar,
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
  onRunEditActivity?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  isComposerDisabled: boolean;
  hideDefaultCancel?: boolean | undefined;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
  slashCommands: readonly SlashCommand[];
  fileMentions: readonly FileMention[];
  onFileMentionQueryChange: ((query: string) => void) | undefined;
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  onComposerTextChange?: ((text: string) => void) | undefined;
  threadKey?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
  workspaceBar?: ReactNode | undefined;
}) => {
  const isHistoryLoading = useAuiState((state) => state.thread.isLoading);
  const composerDisabled = isComposerDisabled || isHistoryLoading;

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
    <ActiveThreadKeyContext.Provider value={threadKey}>
      {/* One follow engine per panel: the thread region attaches the tier-1
          scroller to it, and the follow-up queue bridge fires its BST-1039
          dispatch re-pin through it (thread-scroll-follow.tsx). */}
      <ThreadScrollFollowProvider>
        <ThreadPrimitive.Root className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col">
          <AnsweredApprovalsProvider>
            <ApprovalRanksProvider>
              <AssistantDataRendererRegistration />
              <ThreadDebugPackButton key={threadKey} />
              <ComposerDraftCommandBridge
                composerDraftCommand={composerDraftCommand}
                onComposerDraftCommandApplied={onComposerDraftCommandApplied}
                onComposerTextChange={onComposerTextChange}
              />
              <RunLifecycleNotificationBridge
                {...(onRunEditActivity ? { onRunEditActivity } : {})}
                {...(onRunFailed ? { onRunFailed } : {})}
                {...(onRunFinished ? { onRunFinished } : {})}
                {...(onToolApprovalRequired ? { onToolApprovalRequired } : {})}
                {...(threadKey ? { threadKey } : {})}
              />
              <FollowUpQueueBridge threadKey={threadKey} />
              {/* Drains a successful rewind's target prompt back into the composer
            (Amendment 2). Mounted here rather than on the message, whose own
            button is unmounted by the rewind that hides it. */}
              <RewindComposerBridge />
              {/**
               * Messages viewport + scroll region + jump-to-latest button, all owned by
               * the two-tier thread renderer (assistant-thread-messages.tsx). It picks
               * between the CSS-containment tier and the end-anchored virtualized tier
               * by message count and publishes the choice as `data-thread-render-tier`.
               * Both tiers render THIS components map, so message markup never forks.
               *
               * See: packages/assistant-ui/src/overrides.css
               */}
              <SubagentInvocationIndexProvider key={`invocations:${threadKey}`}>
                <ThreadMessagesRegion
                  components={THREAD_MESSAGE_COMPONENTS}
                  {...(disabledReason ? { disabledReason } : {})}
                  {...(threadKey ? { threadKey } : {})}
                />
              </SubagentInvocationIndexProvider>

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
                {/* Composer workspace bar (folder · branch) — an app-shell-rendered
            SLOT, a SIBLING at the top of the composer stack (never nested
            inside ThreadContextMeter, which is being reworked separately).
            app-shell renders the bar host; assistant-ui stays store-free. */}
                {workspaceBar ?? null}
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
                <ApprovalQueueStrip />
                <ComposerPrimitive.Root
                  className="aui-composer-root"
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
                    hideDefaultCancel={hideDefaultCancel}
                    isComposerDisabled={composerDisabled}
                    queueControl={
                      <ComposerRunControls
                        onSteerActiveRun={onSteerActiveRun}
                        threadKey={threadKey}
                      />
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
            </ApprovalRanksProvider>
          </AnsweredApprovalsProvider>
        </ThreadPrimitive.Root>
      </ThreadScrollFollowProvider>
    </ActiveThreadKeyContext.Provider>
  );
};

// Pure UI layer: state management and data wiring live in app-shell wrapper(s).
export const AssistantUiPanel = ({
  onRuntimeReady,
  className,
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  omSegment,
  openRouterModelMetadataLookup,
  completePreparedRequest,
  effectiveInputBudget,
  providerGroups,
  pickerModels,
  providerSettings,
  recentModels,
  onProviderSettingsChange,
  onProviderSettingsValidationChange: onSettingsValidation,
  selectedProvider,
  selectedModel,
  requestData,
  requestBodyLimitBytes,
  prepareRequestData,
  onModelChange,
  onExitPlanMode,
  onRunEditActivity,
  onRunFailed,
  onRunFinished,
  onStreamActivity,
  onThreadRunStart,
  onTogglePlanMode,
  onToolApprovalRequired,
  onContextBreakdown,
  onChildRunUsage,
  onDelegatedConversation,
  onStepUsage,
  onUsage,
  attachmentsAvailability,
  workspaceBar,
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
  historyGeneration = 0,
  loadLocalLlmBackend,
  localChatTransport = 'local-runtime',
  onStopReread,
  threadKey,
}: AssistantUiPanelProps) => {
  const api = useAssistantEndpointApi();
  // A settled root Stop that cancelled a pause the runtime still shows moves
  // this counter, re-running hydration (and its rediscovery) like a rewind. It
  // carries the thread it was raised FOR: this panel may have switched threads
  // while the cancel settled, and the thread it now shows was never stopped.
  const [stopReread, setStopReread] = useState<{
    generation: number;
    threadKey: string | undefined;
  }>({ generation: 0, threadKey: undefined });
  // Latest-ref sync in an unconditional effect (never during render): the
  // cancel settles long after the Stop, holding the callback from that render.
  const currentThreadKeyRef = useRef(threadKey);
  useEffect(() => {
    currentThreadKeyRef.current = threadKey;
  });
  const rereadAfterStop = useCallback(() => {
    // A stale callback from a thread this panel has since left would bump a
    // generation the key gate ignores, and telling the host then would queue a
    // draft command for a thread that never remounts. Reopening that thread
    // hydrates from the ledger anyway (PR #3214 review).
    if (currentThreadKeyRef.current !== threadKey) {
      return;
    }
    setStopReread((current) => ({ generation: current.generation + 1, threadKey }));
    // Told after the bump and in the same batch, so the draft the host hands
    // back reaches the NEW mount instead of the composer being discarded —
    // the ordering Conversation Rewind's own handoff documents.
    onStopReread?.();
  }, [onStopReread, threadKey]);
  const stopRereadGeneration = stopReread.threadKey === threadKey ? stopReread.generation : 0;
  useEffect(() => {
    void preloadMarkdownText();
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
  const planMode = onTogglePlanMode
    ? {
        enabled: Boolean(planModeEnabled),
        onToggle: onTogglePlanMode,
        ...(onExitPlanMode ? { onExit: onExitPlanMode } : {}),
      }
    : undefined;

  const { handleLocalLoadingStateChange, localLoadingState, prepareLocalModel } =
    useLocalModelLoading({ localViaDataStream, modelName });
  return (
    <MetadataProviders onValidation={onSettingsValidation} value={openRouterModelMetadataLookup}>
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
            fileMentions={fileMentions}
            key={threadKey ? `local:${threadKey}` : 'local'}
            loadLocalLlmBackend={loadLocalLlmBackend}
            localLoadingState={localLoadingState}
            modelId={modelName}
            omSegment={omSegment}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onFileMentionQueryChange={onFileMentionQueryChange}
            onLoadingStateChange={handleLocalLoadingStateChange}
            onModelChange={onModelChange}
            onProviderSettingsChange={onProviderSettingsChange}
            onRunEditActivity={onRunEditActivity}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onRuntimeReady={onRuntimeReady}
            onStreamActivity={onStreamActivity}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            onUsage={onUsage}
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
            workspaceBar={workspaceBar}
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
            fileMentions={fileMentions}
            historyAdapter={historyAdapter}
            // `historyGeneration` and `stopGeneration` are in the key because
            // hydration runs once per MOUNT: an out-of-band change to this
            // thread's durable history (Conversation Rewind) or its pauses (a
            // root Stop cancelling paused work) has no other way to reach a
            // mounted runtime.
            key={
              threadKey
                ? `data-stream:${threadKey}:${historyGeneration}:${stopRereadGeneration}`
                : `data-stream:${stopRereadGeneration}`
            }
            localLoadingState={localLoadingState}
            modelName={modelName}
            omSegment={omSegment}
            onChildRunUsage={onChildRunUsage}
            onComposerDraftCommandApplied={onComposerDraftCommandApplied}
            onComposerTextChange={onComposerTextChange}
            onContextBreakdown={onContextBreakdown}
            onDelegatedConversation={onDelegatedConversation}
            onFileMentionQueryChange={onFileMentionQueryChange}
            onModelChange={onModelChange}
            onPausesCancelled={rereadAfterStop}
            onProviderSettingsChange={onProviderSettingsChange}
            onRunEditActivity={onRunEditActivity}
            onRunFailed={onRunFailed}
            onRunFinished={onRunFinished}
            onRuntimeReady={onRuntimeReady}
            onSteerActiveRun={onSteerActiveRun}
            onStepUsage={onStepUsage}
            onStreamActivity={onStreamActivity}
            onThreadRunStart={onThreadRunStart}
            onToolApprovalRequired={onToolApprovalRequired}
            onUsage={onUsage}
            pickerModels={pickerModels}
            planMode={planMode}
            prepareLocalModel={prepareLocalModel}
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
            workspaceBar={workspaceBar}
          />
        )}
      </section>
    </MetadataProviders>
  );
};

// ===== Message Components =====

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
  const messageId = useAuiState((state) => state.message.id);
  // Bottom rhythm comes from overrides.css (.aui-*-message-root rules).
  const threadKey = use(ActiveThreadKeyContext);
  const compactionSummary = useAuiState((state) =>
    isCompactionSummaryMessage(state.message) ? readCompactionSummaryPayload(state.message) : null
  );
  if (compactionSummary) {
    return (
      <MessagePrimitive.Root
        className="aui-assistant-message-root w-full py-3"
        data-message-id={messageId}
        tabIndex={-1}
      >
        <CompactionSummaryCard
          {...(compactionSummary.droppedSummaryLine === undefined
            ? {}
            : { droppedSummaryLine: compactionSummary.droppedSummaryLine })}
          fallbackKind={compactionSummary.fallbackKind}
        >
          <MessagePrimitive.Parts
            components={{
              /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
              Text: AssistantMessageText,
            }}
          />
        </CompactionSummaryCard>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-2"
      data-message-id={messageId}
      tabIndex={-1}
    >
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-2xl break-words text-foreground leading-6">
        {/* Grouped rendering (activity groups + text + data parts) lives in
            assistant-activity-parts.tsx; see its header for the grouping rule. */}
        <AssistantActivityParts />
        <AssistantMessageError />
        {/* Flight Recorder capstone: copy a redacted Markdown debug bundle for
            THIS failed run to the clipboard. Null without a provider binding
            or a failure signal (run.failed event / assistant-ui error state). */}
        <CopyDebugBundleButton />
        {/* Turn-level "Revert all edits" footer — renders only on desktop turns
            that made ≥1 still-revertible file edit; null everywhere else. */}
        <CheckpointTurnRevert />
        {/* "Edited N files → Review" entry point into the Changes surface —
            null without a ChangesReviewProvider binding, a finished run, a
            known thread id, or any edited files. */}
        <ChangesReviewLink threadId={threadKey} />
        {/* Per-run 👍/👎 verdict (Task Ledger) — renders once per finished run
            on its terminal message leg; null without a verdict provider. */}
        <RunVerdictControl />
      </div>

      <AssistantActionBar />

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

interface ProviderModelHeaderProps {
  groups: ProviderGroupConfig[];
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
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
  onEnableModel,
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
          <ComposerModelPicker
            onEnableModel={onEnableModel}
            onModelChange={onModelChange}
            pickerModels={pickerModels}
            providerGroups={groups}
            recentModels={recentModels}
            selectedModel={selectedModel}
          />
        </div>
        {/* Always-visible reasoning readout/control — one click, never nested
            inside the model menu (BST-948). Renders nothing for models
            without reasoning controls. */}
        <ComposerEffortControl
          onProviderSettingsChange={onProviderSettingsChange}
          providerSettings={providerSettings}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
        />
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
/** Re-exported at their original home so consumers/tests keep one import path. */
export { ThreadScrollRegion, ThreadScrollToBottom };

/**
 * The message components BOTH render tiers use (BST-897). Declared here, after
 * the components themselves, so the static and virtualized lists cannot drift
 * apart — the tier only decides WHICH messages mount, never HOW they render.
 */
const THREAD_MESSAGE_COMPONENTS: ThreadMessageComponents = {
  /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
  AssistantMessage,
  /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
  EditComposer,
  /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
  UserMessage,
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
