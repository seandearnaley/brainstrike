import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import type { AssistantChildInput } from '@brainstrike/assistant-contract';
import { cn } from '@brainstrike/ui';
import type { ComponentProps, ReactElement } from 'react';
import { ActiveConversationInputProvider } from './active-conversation-input';
import type { SendActiveConversationInput } from './active-conversation-input-context';
import { agentColorStyle } from './agent-color-style';
import {
  type ApprovalOwnerThread,
  ApprovalOwnerThreadContext,
} from './approval-owner-thread-context';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import { PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { type AssistantUiPanelProps, ChatThreadUI } from './assistant-ui-panel';
import { type DecisionRoute, DecisionRouteContext } from './decision-route-context';
import { FollowUpQueueOwnershipContext } from './follow-up-queue-ownership';
import { MetadataProviders } from './openrouter-model-metadata-context';
import { type RewindContextValue, RewindProvider } from './rewind-context';

type ThreadSurfaceProps = ComponentProps<typeof ChatThreadUI>;
export type AssistantConversationPanelProps = Partial<
  Omit<ThreadSurfaceProps, 'threadKey' | 'hasGroupedProviders'>
> &
  Pick<
    AssistantUiPanelProps,
    'openRouterModelMetadataLookup' | 'onProviderSettingsValidationChange'
  > & {
    readonly allowIdleInput?: boolean;
    /**
     * True when this surface owns its thread's commands (a root conversation),
     * so it offers and dispatches the thread's follow-up queue. A delegated
     * child's view never does: its runtime belongs to another owner.
     */
    readonly ownsFollowUpQueue?: boolean;
    /** Steering is a queue control: only an owning surface offers it. */
    readonly onSteerActiveRun?: (() => Promise<boolean>) | undefined;
    readonly onSendActiveInput?: SendActiveConversationInput | undefined;
    readonly prepareActiveInput?: ((input: AssistantChildInput) => AssistantChildInput) | undefined;
    readonly className?: string;
    readonly agentColor?: string | undefined;
    readonly decisionRoute?: DecisionRoute | undefined;
    readonly label: string;
    /**
     * The owning root's thread when this view is a delegated child. The host
     * answers a child's approval on the ROOT leg only, so the child's cards
     * read those answers from it (`answered-approvals-index.tsx`).
     */
    readonly ownerThread?: ApprovalOwnerThread | undefined;
    /**
     * "Restore to before this message" for a root conversation whose owner
     * rewinds it; absent, the view offers none (a delegated child's view).
     */
    readonly rewind?: RewindContextValue | null | undefined;
    /** Owned by the host; viewing or closing this panel never starts or stops a run. */
    readonly runtime: AssistantRuntime;
    readonly threadKey: string;
  };

const EMPTY: never[] = [];

/** The main thread's complete surface, bound to an existing conversation runtime. */
export function AssistantConversationPanel({
  className,
  agentColor,
  decisionRoute,
  allowIdleInput = false,
  ownsFollowUpQueue = false,
  onSendActiveInput,
  prepareActiveInput,
  label,
  ownerThread,
  rewind = null,
  runtime,
  threadKey,
  openRouterModelMetadataLookup,
  onProviderSettingsValidationChange,
  providerGroups = EMPTY,
  fileMentions = EMPTY,
  pickerModels = EMPTY,
  slashCommands = EMPTY,
  isComposerDisabled = false,
  ...props
}: AssistantConversationPanelProps): ReactElement {
  return (
    <MetadataProviders
      key={threadKey}
      onValidation={onProviderSettingsValidationChange}
      value={openRouterModelMetadataLookup}
    >
      <section
        aria-label={label}
        className={cn('assistant-ui-panel flex h-full min-h-0 flex-col', className)}
        data-agent-color={agentColor}
        data-testid="assistant-conversation-panel"
        data-thread-key={threadKey}
        style={agentColorStyle(agentColor)}
      >
        <AssistantRuntimeProvider runtime={runtime}>
          <ActiveConversationInputProvider
            allowIdleInput={allowIdleInput}
            onSend={onSendActiveInput}
            prepare={prepareActiveInput}
          >
            <PlanModeExitProvider onExit={props.planMode?.onExit}>
              <RewindProvider value={rewind}>
                <DecisionRouteContext value={decisionRoute ?? null}>
                  <FollowUpQueueOwnershipContext value={ownsFollowUpQueue}>
                    <AssistantPanelErrorBoundary>
                      <ApprovalOwnerThreadContext value={ownerThread ?? null}>
                        <ChatThreadUI
                          disabledReason={undefined}
                          fileMentions={fileMentions}
                          hasGroupedProviders={providerGroups.length > 0}
                          isComposerDisabled={isComposerDisabled}
                          onEnableModel={undefined}
                          onFileMentionQueryChange={undefined}
                          onModelChange={undefined}
                          pickerModels={pickerModels}
                          providerGroups={providerGroups}
                          recentModels={undefined}
                          selectedModel={undefined}
                          selectedProvider={undefined}
                          slashCommands={slashCommands}
                          {...props}
                          threadKey={threadKey}
                        />
                      </ApprovalOwnerThreadContext>
                    </AssistantPanelErrorBoundary>
                  </FollowUpQueueOwnershipContext>
                </DecisionRouteContext>
              </RewindProvider>
            </PlanModeExitProvider>
          </ActiveConversationInputProvider>
        </AssistantRuntimeProvider>
      </section>
    </MetadataProviders>
  );
}
