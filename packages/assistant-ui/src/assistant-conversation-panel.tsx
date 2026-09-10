import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import type { ComponentProps, ReactElement } from 'react';
import { AssistantPanelErrorBoundary } from './assistant-panel-error-boundary';
import { PlanModeExitProvider } from './assistant-tool-suspend-notice';
import { type AssistantUiPanelProps, ChatThreadUI } from './assistant-ui-panel';
import { MetadataProviders } from './openrouter-model-metadata-context';

type ThreadSurfaceProps = ComponentProps<typeof ChatThreadUI>;
export type AssistantConversationPanelProps = Partial<Omit<ThreadSurfaceProps, 'threadKey'>> &
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
        data-testid="chat-panel"
      >
        <AssistantRuntimeProvider runtime={runtime}>
          <PlanModeExitProvider onExit={props.planMode?.onExit}>
            <AssistantPanelErrorBoundary>
              <ChatThreadUI
                disabledReason={undefined}
                fileMentions={EMPTY}
                hasGroupedProviders={providerGroups.length > 0}
                isComposerDisabled={false}
                onFileMentionQueryChange={undefined}
                onModelChange={undefined}
                pickerModels={EMPTY}
                providerGroups={providerGroups}
                recentModels={undefined}
                selectedModel={undefined}
                selectedProvider={undefined}
                slashCommands={EMPTY}
                {...props}
                threadKey={threadKey}
              />
            </AssistantPanelErrorBoundary>
          </PlanModeExitProvider>
        </AssistantRuntimeProvider>
      </section>
    </MetadataProviders>
  );
}
