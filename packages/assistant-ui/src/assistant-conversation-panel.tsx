import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import type { ComponentProps, ReactElement } from 'react';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import { PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { type AssistantUiPanelProps, ChatThreadUI } from './assistant-ui-panel';
import { FollowUpQueueOwnershipContext } from './follow-up-queue-ownership';
import { MetadataProviders } from './openrouter-model-metadata-context';
import { RewindProvider } from './rewind-context';

type ThreadSurfaceProps = ComponentProps<typeof ChatThreadUI>;
export type AssistantConversationPanelProps = Partial<
  Omit<ThreadSurfaceProps, 'threadKey' | 'hasGroupedProviders' | 'onSteerActiveRun'>
> &
  Pick<
    AssistantUiPanelProps,
    'openRouterModelMetadataLookup' | 'onProviderSettingsValidationChange'
  > & {
    readonly className?: string;
    readonly label: string;
    /** Owned by the host; viewing or closing this panel never starts or stops a run. */
    readonly runtime: AssistantRuntime;
    readonly threadKey: string;
  };

const EMPTY: never[] = [];

/** The main thread's complete surface, bound to an existing conversation runtime. */
export function AssistantConversationPanel({
  className,
  label,
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
        data-testid="assistant-conversation-panel"
        data-thread-key={threadKey}
      >
        <AssistantRuntimeProvider runtime={runtime}>
          <PlanModeExitProvider onExit={props.planMode?.onExit}>
            <RewindProvider value={null}>
              <FollowUpQueueOwnershipContext value={false}>
                <AssistantPanelErrorBoundary>
                  <ChatThreadUI
                    disabledReason={undefined}
                    fileMentions={fileMentions}
                    hasGroupedProviders={providerGroups.length > 0}
                    isComposerDisabled={isComposerDisabled}
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
                </AssistantPanelErrorBoundary>
              </FollowUpQueueOwnershipContext>
            </RewindProvider>
          </PlanModeExitProvider>
        </AssistantRuntimeProvider>
      </section>
    </MetadataProviders>
  );
}
