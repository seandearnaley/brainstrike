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
import { Activity, type ReactNode, use, useMemo } from 'react';
import { AnsweredApprovalsProvider } from './answered-approvals-index';
import { ApprovalRanksProvider } from './approval-presentation-context';
import { ApprovalQueueStrip } from './approval-queue-strip';
import { AssistantDataRendererRegistration } from './assistant-data-renderer-registration';
import { useThreadPresentationActivityMode } from './use-thread-presentation-activity-mode';
import './overrides.css';
import type { ModelPickerModel, ModelPickerProvider } from '@brainstrike/ui';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { AssistantActionBar } from './assistant-action-bar';
import { AssistantActivityParts } from './assistant-activity-parts';
import { ControlsMenu } from './assistant-controls-menu';
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
import { ChangesReviewLink } from './changes-review-link';
import { CheckpointTurnRevert } from './checkpoint-turn-revert';
import { CompactionSummaryCard } from './compaction-summary-card';
import {
  isCompactionSummaryMessage,
  readCompactionSummaryPayload,
} from './compaction-summary-message';
import { ComposerAttachmentsBar } from './composer-attachments';
import { type ComposerDraftCommand, ComposerDraftCommandBridge } from './composer-draft-command';
import { ComposerEffortControl } from './composer-effort-control';
import { type ComposerAttachmentsAvailability, ComposerInputWithTriggers } from './composer-input';
import { ComposerModelPicker, modelIdFromCompositeKey } from './composer-model-picker';
import { CopyDebugBundleButton } from './copy-debug-bundle-button';
import { EditComposer } from './edit-composer';
import { RewindComposerBridge } from './message-rewind-action';
import { ThreadBody } from './new-thread-welcome';
import { ThreadDebugPackButton } from './thread-debug-pack-button';
import { UserMessage } from './user-message';

export type { ComposerAttachmentsAvailability } from './composer-input';
// Re-exported for the suites that mount these against a real runtime
// (user-action-bar-copy, assistant-chat-polish.browser) — extraction moved the
// source module, not the public import path.
export { USER_ACTION_BAR_CLASSNAME, UserActionBar, UserMessage } from './user-message';

import { ComposerTriggerPopover } from './composer-trigger-popover';
import {
  type CumulativeUsageDisplay,
  type OmMeterState,
  ThreadContextMeter,
} from './context-usage-meter';
import { FollowUpQueueChips, QueuedDecisionPruner } from './follow-up-queue';
import { RunLifecycleNotificationBridge } from './run-lifecycle-notifications';
import { RunVerdictControl } from './run-verdict-control';
import { RunningStateBridge } from './running-state-bridge';
import {
  buildSlashCommandIconMap,
  type SlashCommand,
  toSlashCommandAdapterOptions,
} from './slash-commands';
import { ThreadScrollFollowProvider } from './thread-scroll-follow';

// Re-export types needed by consumers
export type { ModelPickerModel, ModelPickerProvider };

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

import type {
  AssistantProviderSettingsMap,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';

/**
 * A capability this turn runs WITHOUT — never a reason it cannot run. Lives in
 * the composer shell (a non-scrolling sibling of the viewport) so it stays
 * beside the control it qualifies, instead of scrolling away up the transcript
 * the way `disabledReason` would on a long thread.
 *
 * Its own component rather than an inline conditional: `ChatThreadUI` sits at
 * the cognitive-complexity ceiling, and one more branch there trips the gate.
 */
const CapabilityNotice = ({ text }: { text: string | undefined }) =>
  text ? (
    <p
      aria-live="polite"
      className="px-1 pb-2 text-muted-foreground text-xs"
      data-testid="assistant-capability-notice"
    >
      {text}
    </p>
  ) : null;

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

/** Shared UI component for the chat thread. */
export const ChatThreadUI = ({
  approvalStrip,
  isVisible = true,
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
  disabledReason,
  capabilityNotice,
  slashCommands,
  onComposerDraftCommandApplied,
  onComposerTextChange,
  onSteerActiveRun,
  workspaceBar,
  planMode,
  attachmentsAvailability,
  threadKey,
  toolMenu,
  welcome = false,
}: {
  /**
   * BST-1932: a committed host thread's approvals strip, which counts its
   * delegated children's approvals too; absent → the thread's own strip only.
   */
  approvalStrip?: ReactNode | undefined;
  isVisible?: boolean;
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
  disabledReason: string | undefined;
  capabilityNotice: string | undefined;
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
  const slashAdapterOptions = useMemo(
    () => toSlashCommandAdapterOptions(slashCommands),
    [slashCommands]
  );
  const { adapter: slashAdapter, action: slashAction } =
    useSlashCommandAdapter(slashAdapterOptions);
  const slashIconMap = useMemo(() => buildSlashCommandIconMap(slashCommands), [slashCommands]);

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
                  <div className="bs-composer-shell" data-testid="assistant-composer-shell">
                    {/* A capability the turn will run WITHOUT (e.g. no durable
            memory), as opposed to `disabledReason`, which explains why there
            is no turn at all. It is a SEPARATE prop on purpose: a caller can
            set `disabledReason` without setting `disabled` and still mean
            "blocked" (committed-assistant-conversation.tsx does exactly that
            for host-unavailable, refusing at dispatch), so blocking-ness
            cannot be inferred from `isComposerDisabled`.

            It renders in the composer shell, a sibling of the viewport that
            never scrolls, so it stays beside the control it qualifies.
            `disabledReason` keeps its place above the transcript, where
            native scroll anchoring holds a parked reader still. */}
                    <CapabilityNotice text={capabilityNotice} />
                    {/* The composer toolbar: one line of workspace orientation
            (folder · branch · worktree, an app-shell-rendered slot so
            assistant-ui stays store-free) balanced by the context ring on
            the far right. */}
                    <div className="bs-composer-toolbar" data-testid="assistant-composer-toolbar">
                      {workspaceBar ?? null}
                      <ThreadContextMeter
                        contextWindow={contextWindow}
                        cumulativeUsage={cumulativeUsage}
                        effectiveInputBudget={effectiveInputBudget}
                        omSegment={omSegment}
                        threadKey={threadKey}
                      />
                    </div>
                    {/* Last-24h budget burn-down + over-cap send notice (owned module,
            budget-guardrail-control.tsx); renders nothing without a binding. */}
                    <BudgetGuardrailControl />
                    <FollowUpQueueChips onSteerActiveRun={onSteerActiveRun} threadKey={threadKey} />
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
                        hideDefaultCancel={hideDefaultCancel}
                        isComposerDisabled={composerDisabled}
                        onSteerActiveRun={onSteerActiveRun}
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
                  </div>
                </ThreadBody>
              </Activity>
            </ApprovalRanksProvider>
          </AnsweredApprovalsProvider>
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
        className="aui-assistant-message-root fade-in slide-in-from-bottom-1 w-full animate-in py-3 duration-150"
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
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative grid w-full animate-in grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-2 duration-150"
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

interface ProviderModelControlsProps {
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
}

/** The model menu and, beside it, the always-visible reasoning readout. */
const ProviderModelControls = ({
  groups,
  onEnableModel,
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
