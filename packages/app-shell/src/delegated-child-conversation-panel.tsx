import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import {
  admittedPersonaConfigurationSchema,
  readAdmittedPersonaConfiguration,
} from '@brainstrike/assistant-contract';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { cn } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import {
  resolveComposerAttachmentsAvailability,
  resolveModelNameFromComposite,
  resolveProviderFromComposite,
} from './assistant-ui-panel-wrapper-runtime';
import {
  DelegatedConversationPanel,
  type DelegatedConversationPanelProps,
} from './delegated-conversation-panel';
import type { DelegatedConversationInsightsState } from './delegated-conversation-toolbar';
import {
  type AssistantProviderSource,
  AssistantProviderSourceProvider,
} from './hooks/assistant-provider-source';
import { useAssistantSlashCommands } from './use-assistant-slash-commands';
import { useChildNextRunControls } from './use-child-next-run-controls';
import { useFileMentions } from './use-file-mentions';

type Props = DelegatedConversationPanelProps & {
  readonly insights: DelegatedConversationInsightsState;
  readonly inheritedModel?: string | null;
  readonly isRunning?: boolean;
  readonly inheritedProviderSettings?: AssistantProviderSettingsMap;
  readonly inheritedPlanMode?: boolean;
};

function resolveChildAttachments(
  insights: DelegatedConversationInsightsState,
  models: readonly DbModel[],
  inheritedModel: string | null | undefined,
  isRunning: boolean
) {
  if (insights.status !== 'ready') {
    return {
      reason:
        insights.status === 'error'
          ? insights.error.message
          : 'Loading admitted child configuration…',
      state: 'disabled' as const,
    };
  }
  try {
    const persona = readAdmittedPersonaConfiguration(insights.value.configuration);
    const modelId = isRunning
      ? insights.value.latestRun?.model
      : (resolveModelNameFromComposite(inheritedModel) ?? persona.model?.modelId);
    const providerId = isRunning
      ? insights.value.latestRun?.provider
      : (resolveProviderFromComposite(inheritedModel) ?? persona.model?.provider);
    const model = models.find((item) => item.id === modelId && item.providerId === providerId);
    return resolveComposerAttachmentsAvailability({
      providerGateAvailable: providerId !== 'local',
      selectedModel: model
        ? {
            id: model.id,
            label: model.name,
            vision:
              model.capabilities.vision === undefined
                ? 'unknown'
                : model.capabilities.vision
                  ? 'supported'
                  : 'unsupported',
          }
        : undefined,
    });
  } catch (cause) {
    return {
      reason:
        cause instanceof Error ? cause.message : 'The admitted child configuration is invalid.',
      state: 'disabled' as const,
    };
  }
}

function parseAdmittedPersona(value: unknown) {
  const parsed = admittedPersonaConfigurationSchema.safeParse(value);
  return parsed.success ? readAdmittedPersonaConfiguration(value) : undefined;
}

/** A child conversation's composer discovers its providers like the desktop root's. */
export const CHILD_PROVIDER_SOURCE: AssistantProviderSource = { kind: 'discovery' };
const EMPTY_SETTINGS: AssistantProviderSettingsMap = {};
function CapableChildPanel({
  insights,
  inheritedModel,
  inheritedProviderSettings = EMPTY_SETTINGS,
  inheritedPlanMode = false,
  isRunning = false,
  ...props
}: Props) {
  const persona =
    insights.status === 'ready' ? parseAdmittedPersona(insights.value.configuration) : undefined;
  const admittedConfigurationReady = insights.status === 'ready' && persona !== undefined;
  const controls = useChildNextRunControls({
    inheritedModel: inheritedModel ?? null,
    inheritedPlanMode,
    inheritedProviderSettings,
    isRunning: () => isRunning,
    persona,
  });
  const [query, setQuery] = useState('');
  const { fileMentions } = useFileMentions(query);
  const slashCommands = useAssistantSlashCommands(props.threadId);
  const command = useAssistantComposerCommandStore(
    (state) => state.commandsByThreadId[props.threadId]?.[0]
  );
  const recordDraft = useAssistantComposerCommandStore((state) => state.recordDraft);
  const acknowledge = useAssistantComposerCommandStore((state) => state.acknowledge);
  const models = useModelRegistryStore((state) => state.models);
  const onTextChange = useCallback(
    (text: string) => recordDraft(props.threadId, text),
    [props.threadId, recordDraft]
  );
  const onCommandApplied = useCallback(
    (id: string) => {
      if (!command || command.id !== id) {
        throw new Error(`Cannot acknowledge unknown child composer command: ${id}`);
      }
      acknowledge(props.threadId, id);
    },
    [acknowledge, command, props.threadId]
  );
  const attachmentsAvailability = resolveChildAttachments(
    insights,
    models,
    controls.selectedModel ?? inheritedModel,
    isRunning
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {controls.error ? (
        <p className="shrink-0 px-2 text-destructive text-xs" role="alert">
          {controls.error}
        </p>
      ) : null}
      <DelegatedConversationPanel
        {...props}
        allowIdleInput={admittedConfigurationReady && props.allowIdleInput === true}
        onBranch={admittedConfigurationReady ? props.onBranch : undefined}
        panelProps={{
          ...props.panelProps,
          ...controls.panelProps,
          attachmentsAvailability,
          className: cn(
            props.panelProps?.className,
            controls.panelProps.className,
            'min-h-0 flex-1'
          ),
          composerDraftCommand: command,
          fileMentions,
          onComposerDraftCommandApplied: onCommandApplied,
          onComposerTextChange: onTextChange,
          onFileMentionQueryChange: setQuery,
          prepareActiveInput: controls.prepareInput,
          slashCommands,
        }}
        prepareBranchInput={controls.prepareInput}
      />
    </div>
  );
}

/** Same main composer menus, with commands and receipts bound to the child. */
export function DelegatedChildConversationPanel(props: Props) {
  if (!hasDurableAssistantUsageCapability()) {
    const {
      insights: _insights,
      inheritedModel: _inheritedModel,
      isRunning: _isRunning,
      inheritedProviderSettings: _inheritedProviderSettings,
      inheritedPlanMode: _inheritedPlanMode,
      ...panel
    } = props;
    return <DelegatedConversationPanel {...panel} />;
  }
  return (
    <AssistantProviderSourceProvider source={CHILD_PROVIDER_SOURCE}>
      <CapableChildPanel key={props.threadId} {...props} />
    </AssistantProviderSourceProvider>
  );
}
