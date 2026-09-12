import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { readAdmittedPersonaConfiguration } from '@brainstrike/assistant-contract';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { useCallback, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { resolveComposerAttachmentsAvailability } from './assistant-ui-panel-wrapper-runtime';
import {
  DelegatedConversationPanel,
  type DelegatedConversationPanelProps,
} from './delegated-conversation-panel';
import type { DelegatedConversationInsightsState } from './delegated-conversation-toolbar';
import { useAssistantSlashCommands } from './use-assistant-slash-commands';
import { useFileMentions } from './use-file-mentions';

type Props = DelegatedConversationPanelProps & {
  readonly insights: DelegatedConversationInsightsState;
};

function resolveChildAttachments(
  insights: DelegatedConversationInsightsState,
  models: readonly DbModel[]
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
    const modelId = insights.value.latestRun?.model ?? persona.model?.modelId;
    const providerId = insights.value.latestRun?.provider ?? persona.model?.provider;
    const model = models.find((item) => item.id === modelId && item.providerId === providerId);
    return resolveComposerAttachmentsAvailability({
      providerGateAvailable: true,
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

function CapableChildPanel({ insights, ...props }: Props) {
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
  const attachmentsAvailability = resolveChildAttachments(insights, models);
  return (
    <DelegatedConversationPanel
      {...props}
      panelProps={{
        ...props.panelProps,
        attachmentsAvailability,
        composerDraftCommand: command,
        fileMentions,
        onComposerDraftCommandApplied: onCommandApplied,
        onComposerTextChange: onTextChange,
        onFileMentionQueryChange: setQuery,
        slashCommands,
      }}
    />
  );
}

/** Same main composer menus, with commands and receipts bound to the child. */
export function DelegatedChildConversationPanel(props: Props) {
  if (!hasDurableAssistantUsageCapability()) {
    const { insights: _insights, ...panel } = props;
    return <DelegatedConversationPanel {...panel} />;
  }
  return <CapableChildPanel {...props} />;
}
