import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import type { OpenRouterModelMetadataLookup } from '@brainstrike/assistant-contract';
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
import { ChatThreadUI } from './assistant-ui-panel';
import { type DecisionRoute, DecisionRouteContext } from './decision-route-context';
import { MetadataProviders } from './openrouter-model-metadata-context';
import { type RewindContextValue, RewindProvider } from './rewind-context';

type ThreadSurfaceProps = ComponentProps<typeof ChatThreadUI>;
export type AssistantConversationPanelProps = Partial<
  Omit<ThreadSurfaceProps, 'threadKey' | 'hasGroupedProviders'>
> & {
  readonly openRouterModelMetadataLookup?: OpenRouterModelMetadataLookup | undefined;
  readonly onProviderSettingsValidationChange?: ((reason: string | undefined) => void) | undefined;
  readonly allowIdleInput?: boolean;
  readonly onSendActiveInput?: SendActiveConversationInput | undefined;
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
  onSendActiveInput,
  label,
  ownerThread,
  rewind = null,
  runtime,
  threadKey,
  openRouterModelMetadataLookup,
  onProviderSettingsValidationChange,
  providerGroups = EMPTY,
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
          >
            <PlanModeExitProvider onExit={props.planMode?.onExit}>
              <RewindProvider value={rewind}>
                <DecisionRouteContext value={decisionRoute ?? null}>
                  <AssistantPanelErrorBoundary>
                    <ApprovalOwnerThreadContext value={ownerThread ?? null}>
                      <ChatThreadUI
                        disabledReason={undefined}
                        hasGroupedProviders={providerGroups.length > 0}
                        isComposerDisabled={isComposerDisabled}
                        onEnableModel={undefined}
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
                </DecisionRouteContext>
              </RewindProvider>
            </PlanModeExitProvider>
          </ActiveConversationInputProvider>
        </AssistantRuntimeProvider>
      </section>
    </MetadataProviders>
  );
}
