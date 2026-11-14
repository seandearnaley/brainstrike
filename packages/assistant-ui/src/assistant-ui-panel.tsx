/// <reference path="./vite-env.d.ts" />
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
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
} from '@brainstrike/assistant-contract';
import { Activity, type ReactNode, use, useState } from 'react';
import { AnsweredApprovalsProvider } from './answered-approvals-index';
import { ApprovalRanksProvider } from './approval-presentation-context';
import { ApprovalQueueStrip } from './approval-queue-strip';
import { AssistantDataRendererRegistration } from './assistant-data-renderer-registration';
import { useThreadPresentationActivityMode } from './use-thread-presentation-activity-mode';
import './overrides.css';
import type {
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';
import type { ModelPickerModel } from '@brainstrike/ui';
import { DiagramFullSizeContainerContext } from '@brainstrike/ui/diagram-full-size-container';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { AssistantActionBar } from './assistant-action-bar';
import { AssistantActivityParts } from './assistant-activity-parts';
import { ControlsMenu } from './assistant-controls-menu';
import { AssistantGenerationMark } from './assistant-generation-mark';
import { AssistantMessageError } from './assistant-message-error';
import { AssistantMessageText } from './assistant-message-text';
import {
  type ThreadMessageComponents,
  ThreadMessagesRegion,
  ThreadScrollRegion,
  ThreadScrollToBottom,
} from './assistant-thread-messages';
import { BranchPicker } from './branch-picker';
import { BudgetGuardrailControl } from './budget-guardrail-control';
import { CheckpointTurnRevert } from './checkpoint-turn-revert';
import { CompactionSummaryCard } from './compaction-summary-card';
import {
  isCompactionSummaryMessage,
  readCompactionSummaryPayload,
} from './compaction-summary-message';
import type { AccessModeComposerControls } from './composer-access-mode-control';
import { ComposerAttachmentsBar } from './composer-attachments';
import { type ComposerDraftCommand, ComposerDraftCommandBridge } from './composer-draft-command';
import { ComposerEffortControl } from './composer-effort-control';
import { ComposerImageDropShell } from './composer-image-drop';
import { type ComposerAttachmentsAvailability, ComposerInputWithTriggers } from './composer-input';
import { ComposerModelPicker } from './composer-model-picker';
import { modelIdFromCompositeKey } from './composer-picker-sections';
import { ComposerTriggerPopover } from './composer-trigger-popover';
import { type CumulativeUsageDisplay, ThreadContextMeter } from './context-usage-meter';
import { CopyDebugBundleButton } from './copy-debug-bundle-button';
import { EditComposer } from './edit-composer';
import { FollowUpQueueChips, QueuedDecisionPruner } from './follow-up-queue';
import { RewindComposerBridge } from './message-rewind-action';
import { type ComposerDisabledAction, ThreadBody } from './new-thread-welcome';
import { RunLifecycleNotificationBridge } from './run-lifecycle-notifications';
import { RunVerdictControl } from './run-verdict-control';
import { RunningStateBridge } from './running-state-bridge';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from './slash-commands';
import { ThreadDebugPackButton } from './thread-debug-pack-button';
import { ThreadScrollFollowProvider } from './thread-scroll-follow';
import { TurnChangesCard } from './turn-changes-card';
import { UserMessage } from './user-message';

export type { AccessModeComposerControls } from './composer-access-mode-control';
export type { ComposerAttachmentsAvailability } from './composer-input';
// Re-exported for the suites that mount these against a real runtime
// (user-action-bar-copy, assistant-chat-polish.browser) — extraction moved the
// source module, not the public import path.
export { USER_ACTION_BAR_CLASSNAME, UserActionBar, UserMessage } from './user-message';

// Re-export types needed by consumers
export type { ModelPickerModel };

export interface ProviderConfig {
  defaultModel: string;
  id: string;
  models: readonly string[];
  name: string;
}

export type ProviderRuntimeCategory = 'hosted' | 'gateway';

export interface ProviderModelOptionConfig {
  default?: boolean;
  enabled: boolean;
  id: string;
  label: string;
  supportsStreaming?: boolean;
  type: 'llm';
  /** The model's maker from its catalog row; absent for an uncatalogued model. */
  vendor?: { readonly id: string; readonly name: string } | undefined;
}

export interface ProviderOptionConfig {
  capabilities: {
    streaming: boolean;
  };
  id: string;
  models: ProviderModelOptionConfig[];
  name: string;
  runtime: ProviderRuntimeCategory;
}

export interface ProviderGroupConfig {
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
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
} from '@brainstrike/types';
export type { ComposerDraftCommand } from './composer-draft-command';

/**
 * The active thread's id (assistant-ui's own `ThreadState` carries no id —
 * see `@assistant-ui/core`'s `store/scopes/thread.ts` — so it is not
 * reachable from `useAuiState` inside a message). `ChatThreadUI` already
 * receives it as `threadKey` (app-shell's `selectedMemoryThreadId`, threaded
 * down as a React prop from `assistant-ui-panel-wrapper.tsx`); this context
 * re-publishes that same value for descendants rendered by assistant-ui
 * itself (e.g. `AssistantMessage`, which the library instantiates with no
 * props of its own) — currently only `TurnChangesCard`, whose reads and
 * Review name the turn's thread.
 */

/** Shared UI component for the chat thread. */
export const ChatThreadUI = ({
  accessMode,
  approvalStrip,
  isVisible = true,
  compactionTrigger,
  composerDraftCommand,
  contextWindow,
  cumulativeUsage,
  providerGroups,
  hasGroupedProviders,
  pickerModels,
  providerSettings,
  recentModels,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onEnableModel,
  onModelChange,
  onRunEditActivity,
  onRunFailed,
  onRunFinished,
  onRunningChange,
  onThreadRunStart,
  onToolApprovalRequired,
  isComposerDisabled,
  hideDefaultCancel,
  disabledAction,
  disabledReason,
  onManageModels,
  slashCommands,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  canSteer,
  workspaceBar,
  planMode,
  attachmentsAvailability,
  threadKey,
  toolMenu,
  welcome = false,
}: {
  /** The composer's access mode control; absent where no policy owner is wired. */
  accessMode?: AccessModeComposerControls | undefined;
  /**
   * BST-1932: a committed host thread's approvals strip, which counts its
   * delegated children's approvals too; absent → the thread's own strip only.
   */
  approvalStrip?: ReactNode | undefined;
  isVisible?: boolean;
  /** The request size at which the thread compacts; the context meter fills toward it. */
  compactionTrigger?: number | undefined;
  composerDraftCommand?: ComposerDraftCommand | undefined;
  contextWindow?: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  attachmentsAvailability?: ComposerAttachmentsAvailability | undefined;
  canSteer?: boolean | undefined;
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
  onEnableModel: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  onRunEditActivity?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFailed?: ((event: AssistantRunEvent) => void) | undefined;
  onRunFinished?: ((event: AssistantRunEvent) => void) | undefined;
  onRunningChange?: ((threadKey: string, running: boolean) => void) | undefined;
  onThreadRunStart?: (() => void) | undefined;
  onToolApprovalRequired?: ((request: AssistantToolApprovalRequest) => void) | undefined;
  isComposerDisabled: boolean;
  hideDefaultCancel?: boolean | undefined;
  /** The fix for `disabledReason` (e.g. open Settings → Providers), offered on the welcome. */
  disabledAction?: ComposerDisabledAction | undefined;
  disabledReason: string | undefined;
  /** Opens the host's model settings from the model picker; absent, the picker offers none. */
  onManageModels?: (() => void) | undefined;
  slashCommands: readonly SlashCommand[];
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  onComposerTextChange?: ((text: string) => void) | undefined;
  threadKey?: string | undefined;
  toolMenu?: AssistantToolMenuConfig | undefined;
  workspaceBar?: ReactNode | undefined;
  /** A new thread: its composer sits centred under a welcome until the first send. */
  welcome?: boolean | undefined;
}) => {
  const isHistoryLoading = useAuiState((state) => state.thread.isLoading);
  const presentationMode = useThreadPresentationActivityMode(isVisible);
  const composerDisabled = isComposerDisabled || isHistoryLoading;

  // Slash-command "/" menu: derive the library adapter + icon lookup from the
  // app-passed commands during render (no setState-in-effect). The adapter hook
  // is memoized on the command list and always runs (rules-of-hooks), but the
  // slash popover is only MOUNTED when there are commands — the installed
  // @assistant-ui opens the popover whenever "/" is typed and an adapter is
  // present, regardless of whether search() returns items, so mounting it with
  // an empty list would surface an empty menu. "No commands" ⇒ no slash feature.
  const hasSlashCommands = slashCommands.length > 0;
  const slashAdapterOptions = toSlashCommandAdapterOptions(slashCommands);
  const { adapter: slashAdapter, action: slashAction } =
    useSlashCommandAdapter(slashAdapterOptions);
  const slashIconMap = buildSlashCommandIconMap(slashCommands);
  // A diagram's full-size view fills the thread (messages and composer).
  const [threadRoot, setThreadRoot] = useState<HTMLDivElement | null>(null);

  return (
    <ActiveThreadKeyContext.Provider value={threadKey}>
      {/* One follow engine per panel: the thread region attaches the tier-1
          scroller to it, and the follow-up queue bridge fires its BST-1039
          dispatch re-pin through it (thread-scroll-follow.tsx). */}
      <ThreadScrollFollowProvider>
        <ThreadPrimitive.Root
          className="aui-root aui-thread-root bs-thread relative flex h-full min-h-0 flex-col"
          ref={setThreadRoot}
        >
          <DiagramFullSizeContainerContext.Provider value={threadRoot}>
            <AnsweredApprovalsProvider>
              <ApprovalRanksProvider>
                <AssistantDataRendererRegistration />
                <ThreadDebugPackButton key={threadKey} />
                <ComposerDraftCommandBridge
                  composerDraftCommand={composerDraftCommand}
                  onComposerDraftCommandApplied={onComposerDraftCommandApplied}
                  onComposerTextChange={onComposerTextChange}
                />
                {onRunningChange && threadKey ? (
                  <RunningStateBridge onRunningChange={onRunningChange} threadKey={threadKey} />
                ) : null}
                <RunLifecycleNotificationBridge
                  {...(onRunEditActivity ? { onRunEditActivity } : {})}
                  {...(onRunFailed ? { onRunFailed } : {})}
                  {...(onRunFinished ? { onRunFinished } : {})}
                  {...(onToolApprovalRequired ? { onToolApprovalRequired } : {})}
                  {...(threadKey ? { threadKey } : {})}
                />
                <QueuedDecisionPruner threadKey={threadKey} />
                {/* Drains a successful rewind's target prompt back into the composer
            (Amendment 2). Mounted here rather than on the message, whose own
            button is unmounted by the rewind that hides it. */}
                <RewindComposerBridge />
                <Activity mode={presentationMode}>
                  {/**
                   * Messages viewport + scroll region + jump-to-latest button, all owned by
                   * the two-tier thread renderer (assistant-thread-messages.tsx). It picks
                   * between the CSS-containment tier and the end-anchored virtualized tier
                   * by message count and publishes the choice as `data-thread-render-tier`.
                   * Both tiers render THIS components map, so message markup never forks.
                   *
                   * See: packages/assistant-ui/src/overrides.css
                   */}
                  <ThreadBody
                    disabledAction={disabledAction}
                    disabledReason={disabledReason}
                    messages={
                      <ThreadMessagesRegion
                        components={THREAD_MESSAGE_COMPONENTS}
                        {...(disabledReason ? { disabledReason } : {})}
                        {...(threadKey ? { threadKey } : {})}
                      />
                    }
                    welcome={welcome}
                  >
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
                    <ComposerImageDropShell
                      attachmentsAvailability={attachmentsAvailability}
                      disabled={composerDisabled}
                    >
                      {/* The composer toolbar: one line of workspace orientation
            (folder · branch · worktree, an app-shell-rendered slot so
            assistant-ui stays store-free) balanced by the context ring on
            the far right. */}
                      <div className="bs-composer-toolbar" data-testid="assistant-composer-toolbar">
                        {workspaceBar ?? null}
                        <ThreadContextMeter
                          compactionTrigger={compactionTrigger}
                          contextWindow={contextWindow}
                          cumulativeUsage={cumulativeUsage}
                          threadKey={threadKey}
                        />
                      </div>
                      {/* Last-24h budget burn-down + over-cap send notice (owned module,
            budget-guardrail-control.tsx); renders nothing without a binding. */}
                      <BudgetGuardrailControl />
                      <FollowUpQueueChips canSteer={canSteer} threadKey={threadKey} />
                      <ApprovalQueueStrip key={threadKey} />
                      {approvalStrip ?? null}
                      <ComposerPrimitive.Root
                        className="aui-composer-root"
                        onSubmitCapture={onThreadRunStart}
                      >
                        {/* The composer input row, optionally wrapped in a shared
              `Unstable_TriggerPopoverRoot` (see `ComposerInputWithTriggers`).
              The slash popover declares its own trigger char ("/") and reads the
              composer text via that shared root. It is mounted ONLY when its
              seam is present — an unmounted popover means the trigger char does
              nothing special (never an empty menu). Send / Cancel are unchanged. */}
                        {/* Mounted on PRESENCE (enabled or disabled): a staged image keeps
              its preview + Remove button after a switch to a text-only model. */}
                        {attachmentsAvailability ? <ComposerAttachmentsBar /> : null}
                        <ComposerInputWithTriggers
                          canSteer={canSteer}
                          hideDefaultCancel={hideDefaultCancel}
                          isComposerDisabled={composerDisabled}
                          {...(attachmentsAvailability ? { attachmentsAvailability } : {})}
                          {...(planMode ? { planMode } : {})}
                          {...(accessMode ? { accessMode } : {})}
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
                          {...(hasGroupedProviders
                            ? {
                                footerEnd: (
                                  <ControlsMenu
                                    modelName={modelIdFromCompositeKey(selectedModel)}
                                    onProviderSettingsChange={onProviderSettingsChange}
                                    providerSettings={providerSettings}
                                    selectedProvider={selectedProvider}
                                    toolMenu={toolMenu}
                                  />
                                ),
                                footerStart: (
                                  <ProviderModelControls
                                    groups={providerGroups}
                                    onEnableModel={onEnableModel}
                                    onManageModels={onManageModels}
                                    onModelChange={onModelChange}
                                    onProviderSettingsChange={onProviderSettingsChange}
                                    pickerModels={pickerModels}
                                    providerSettings={providerSettings}
                                    recentModels={recentModels}
                                    selectedModel={selectedModel}
                                    selectedProvider={selectedProvider}
                                  />
                                ),
                              }
                            : {})}
                        />
                      </ComposerPrimitive.Root>
                    </ComposerImageDropShell>
                  </ThreadBody>
                </Activity>
              </ApprovalRanksProvider>
            </AnsweredApprovalsProvider>
          </DiagramFullSizeContainerContext.Provider>
        </ThreadPrimitive.Root>
      </ThreadScrollFollowProvider>
    </ActiveThreadKeyContext.Provider>
  );
};

// ===== Message Components =====

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
        className="aui-assistant-message-root fade-in slide-in-from-bottom-1 animate-in w-full py-3 duration-150"
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
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 animate-in relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-2 duration-150"
      data-message-id={messageId}
      tabIndex={-1}
    >
      {/* The maker mark of the model that wrote this message, with its run's details. */}
      <AssistantGenerationMark className="col-start-1 row-start-1 mt-1.5 mr-2" />
      <div className="aui-assistant-message-content text-foreground col-span-2 col-start-2 row-start-1 my-1.5 max-w-2xl leading-6 break-words">
        {/* Grouped rendering (activity groups + text + data parts) lives in
            assistant-activity-parts.tsx; see its header for the grouping rule. */}
        <AssistantActivityParts />
        <AssistantMessageError />
        {/* Flight Recorder capstone: copy a redacted Markdown debug bundle for
            THIS failed run to the clipboard. Null without a provider binding
            or a failure signal (run.failed event / assistant-ui error state). */}
        <CopyDebugBundleButton />
        {/* The turn's changed files with their diffs and Review — null without
            a ChangesReviewProvider binding, a finished run, a known thread id,
            or any edited files. */}
        <TurnChangesCard threadId={threadKey} />
        {/* Turn-level "Revert all edits" footer — renders only on desktop turns
            that made ≥1 still-revertible file edit; null everywhere else. */}
        <CheckpointTurnRevert />
      </div>

      {/* One footer line: the per-run 👍/👎 verdict (Task Ledger; once per
          finished run, on its terminal leg) then Copy/Retry. Inline flow, not
          flex: the action bar floats (absolute) on older messages, and only an
          inline static position keeps it after the verdict, not on top of it.
          min-w-0: a long verdict label wraps inside the column, never widens it. */}
      <div className="col-start-3 row-start-2 -ml-1 min-w-0 leading-5">
        <RunVerdictControl />
        <AssistantActionBar />
      </div>

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

interface ProviderModelControlsProps {
  groups: ProviderGroupConfig[];
  onEnableModel?: ((providerId: string, modelId: string) => Promise<boolean>) | undefined;
  onManageModels?: (() => void) | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  pickerModels: ModelPickerModel[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  recentModels?: readonly string[] | undefined;
  selectedModel?: string | undefined;
  selectedProvider?: string | undefined;
}

/** The model menu and, beside it, the always-visible reasoning readout. */
const ProviderModelControls = ({
  groups,
  onEnableModel,
  onManageModels,
  pickerModels,
  providerSettings,
  onProviderSettingsChange,
  recentModels,
  selectedProvider,
  selectedModel,
  onModelChange,
}: ProviderModelControlsProps) => (
  <>
    <div className="bs-composer-model-slot" data-testid="assistant-model-dropdown">
      <ComposerModelPicker
        onEnableModel={onEnableModel}
        onManageModels={onManageModels}
        onModelChange={onModelChange}
        pickerModels={pickerModels}
        providerGroups={groups}
        recentModels={recentModels}
        selectedModel={selectedModel}
      />
    </div>
    {/* Always-visible reasoning readout/control — one click, never nested
        inside the model menu (BST-948). Renders nothing for models without
        reasoning controls. */}
    <ComposerEffortControl
      onProviderSettingsChange={onProviderSettingsChange}
      providerSettings={providerSettings}
      selectedModel={selectedModel}
      selectedProvider={selectedProvider}
    />
  </>
);

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
