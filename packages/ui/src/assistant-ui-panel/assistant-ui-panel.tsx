import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import { useDataStreamRuntime } from '@assistant-ui/react-data-stream';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import '@assistant-ui/styles/index.css';
import '@assistant-ui/styles/markdown.css';
import './overrides.css';
import { Badge } from '../badge';
import { Button } from '../button';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { TooltipIconButton } from './tooltip-icon-button';

// Re-export types needed by consumers
export type { ModelPickerModel, ModelPickerProvider };

export type ProviderConfig = {
  id: string;
  name: string;
  models: readonly string[];
  defaultModel: string;
};

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export type ProviderModelOptionConfig = {
  id: string;
  label: string;
  type: 'llm' | 'embedding';
  enabled: boolean;
  default?: boolean;
  supportsStreaming?: boolean;
  supportsStandardDimension?: boolean;
};

export type ProviderOptionConfig = {
  id: string;
  name: string;
  runtime: ProviderRuntimeCategory;
  capabilities: {
    llm: boolean;
    embeddings: boolean;
    streaming: boolean;
    supportsStandardEmbeddingDimension: boolean;
  };
  models: ProviderModelOptionConfig[];
};

export type ProviderGroupConfig = {
  runtime: ProviderRuntimeCategory;
  label: string;
  providers: ProviderOptionConfig[];
};

export type AssistantUiPanelProps = {
  className?: string;
  providers?: ProviderConfig[];
  providerGroups?: ProviderGroupConfig[];
  /** Models for the ModelPicker component */
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  selectedProvider?: string;
  selectedModel?: string;
  onModelChange?: (compositeKey: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

export const AssistantUiPanel: FC<AssistantUiPanelProps> = ({
  providerGroups,
  pickerModels,
  pickerProviders,
  selectedProvider,
  selectedModel,
  onModelChange,
  disabled = false,
  disabledReason,
}) => {
  const initialApi =
    typeof window === 'undefined'
      ? '/api/assistant'
      : window.assistant?.url
        ? `${window.assistant.url}/assistant`
        : '/api/assistant';
  const [api, setApi] = useState<string>(initialApi);

  useEffect(() => {
    const updateApi = async () => {
      try {
        const url = await window.assistant?.getUrl?.();
        if (url) {
          setApi(`${url}/assistant`);
        }
      } catch {
        // Ignore errors from getUrl
      }
    };

    void updateApi();
  }, []);

  const groupedProviders = providerGroups ?? [];
  const flattenedGroupedProviders = groupedProviders.flatMap((group) => group.providers);
  const hasGroupedProviders = flattenedGroupedProviders.length > 0;

  const isComposerDisabled = Boolean(disabled);

  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  const runtime = useDataStreamRuntime({
    api,
    body: {
      data: {
        provider: selectedProvider,
        model: modelName,
      },
    },
  });

  return (
    <section
      aria-label="Assistant chat"
      className="flex h-full min-h-0 flex-col"
      data-testid="chat-panel"
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col">
          {/* Provider and Model Selector Header */}
          {hasGroupedProviders && (
            <ProviderModelHeader
              groups={groupedProviders}
              onModelChange={onModelChange}
              pickerModels={pickerModels}
              pickerProviders={pickerProviders}
              selectedModel={selectedModel}
              selectedProvider={selectedProvider}
            />
          )}
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
           * Post-mortem: docs/2025-09-30-assistant-ui-layout-fix-postmortem.md
           */}
          <ThreadPrimitive.Viewport
            aria-atomic="false"
            aria-live="polite"
            className="aui-thread-viewport"
            data-testid="assistant-ui-viewport"
          >
            {disabledReason && (
              <p aria-live="polite" className="px-4 py-3 text-muted-foreground text-xs">
                {disabledReason}
              </p>
            )}
            <ThreadPrimitive.Messages
              components={{
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                AssistantMessage,
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                UserMessage,
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                EditComposer,
              }}
            />
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
          <div className="flex-shrink-0 border-border border-t bg-background">
            <ComposerPrimitive.Root
              aria-disabled={isComposerDisabled}
              className="aui-composer-root"
              data-disabled={isComposerDisabled ? '' : undefined}
            >
              <ComposerPrimitive.Input
                aria-label="Message input"
                className="aui-composer-input"
                disabled={isComposerDisabled}
                id="assistant-input"
                placeholder="Ask the assistant…"
                rows={1}
              />
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send
                  className="aui-button aui-button-primary aui-composer-send"
                  disabled={isComposerDisabled}
                >
                  Send
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel
                  className="aui-button aui-button-primary aui-composer-cancel"
                  disabled={isComposerDisabled}
                >
                  Stop
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </section>
  );
};

// ===== Message Components =====

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 py-3 [&:where(>*)]:col-start-2">
      <UserActionBar />

      <div className="aui-user-message-content col-start-2 row-start-2 max-w-xl break-words rounded-2xl bg-muted px-4 py-2">
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: MarkdownText,
          }}
        />
      </div>

      <BranchPicker className="-mr-1 col-span-full col-start-1 row-start-3 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    className="col-start-1 row-start-2 mt-2 mr-3 flex flex-col items-end"
    hideWhenRunning
  >
    <ActionBarPrimitive.Edit asChild>
      <TooltipIconButton aria-label="Edit message" tooltip="Edit">
        <PencilIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Edit>
  </ActionBarPrimitive.Root>
);

const EditComposer: FC = () => (
  <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
    <ComposerPrimitive.Input className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none" />

    <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
      <ComposerPrimitive.Cancel asChild>
        <Button size="sm" variant="ghost">
          Cancel
        </Button>
      </ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send asChild>
        <Button size="sm">Send</Button>
      </ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>
);

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-3">
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-xl break-words text-foreground leading-7">
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: MarkdownText,
            tools: {
              /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Fallback" key */
              Fallback: ToolFallback,
            },
          }}
        />
      </div>

      <AssistantActionBar />

      <BranchPicker className="-ml-2 col-start-2 row-start-2 mr-2" />
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className="-ml-1 col-start-3 row-start-2 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm"
    hideWhenRunning
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton aria-label="Copy message" tooltip="Copy">
        <MessagePrimitive.If copied>
          <CheckIcon className="size-4" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <CopyIcon className="size-4" />
        </MessagePrimitive.If>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton aria-label="Regenerate response" tooltip="Retry">
        <RefreshCwIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);

const BranchPicker: FC<{ className?: string }> = ({ className }) => (
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

const RUNTIME_LABELS: Record<ProviderRuntimeCategory, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

type ProviderModelOption = {
  value: string;
  provider: ProviderOptionConfig;
  model: ProviderModelOptionConfig;
  groupLabel: string;
};

type NormalizedProviderGroup = {
  runtime: ProviderRuntimeCategory;
  label: string;
  providers: Array<{
    provider: ProviderOptionConfig;
    models: ProviderModelOptionConfig[];
  }>;
};

type ProviderModelHeaderProps = {
  groups: ProviderGroupConfig[];
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
};

const ProviderModelHeader: FC<ProviderModelHeaderProps> = ({
  groups,
  pickerModels,
  pickerProviders,
  selectedProvider,
  selectedModel,
  onModelChange,
}) => {
  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  const normalizedGroups = useMemo<NormalizedProviderGroup[]>(
    () =>
      groups
        .map((group) => {
          const providers = group.providers
            .map((provider) => ({
              provider,
              models: provider.models.filter((model) => model.enabled),
            }))
            .filter((entry) => entry.models.length > 0);
          if (providers.length === 0) {
            return null;
          }
          return {
            runtime: group.runtime,
            label: group.label ?? RUNTIME_LABELS[group.runtime],
            providers,
          };
        })
        .filter((group): group is NormalizedProviderGroup => group !== null),
    [groups]
  );

  const options = useMemo<ProviderModelOption[]>(
    () =>
      normalizedGroups.flatMap((group) =>
        group.providers.flatMap((entry) =>
          entry.models.map((model) => ({
            value: `${entry.provider.id}::${model.id}`,
            provider: entry.provider,
            model,
            groupLabel: group.label,
          }))
        )
      ),
    [normalizedGroups]
  );

  const selectedOption = useMemo<ProviderModelOption | undefined>(
    () =>
      options.find(
        (option) => option.provider.id === selectedProvider && option.model.id === modelName
      ),
    [options, modelName, selectedProvider]
  );

  // Build a lookup map from model ID to provider ID for the ModelPicker callback
  const modelToProviderMap = useMemo(() => {
    const map = new Map<string, string>();
    if (pickerModels) {
      for (const model of pickerModels) {
        map.set(model.id, model.providerId);
      }
    }
    return map;
  }, [pickerModels]);

  // Handle ModelPicker selection - convert model ID to composite key
  const handleModelPickerChange = useCallback(
    (modelId: string | string[]) => {
      const id = Array.isArray(modelId) ? modelId[0] : modelId;
      if (!id) {
        return;
      }

      const providerId = modelToProviderMap.get(id);
      if (providerId) {
        // Construct composite key: "provider::model"
        onModelChange?.(`${providerId}::${id}`);
      }
    },
    [modelToProviderMap, onModelChange]
  );

  const summaryProps: ProviderSelectionSummaryProps = {
    provider: selectedOption?.provider,
    model: selectedOption?.model,
    selectedProvider,
    selectedModel,
  };

  return (
    <div className="flex-shrink-0 space-y-3 border-border border-b bg-muted/30 px-3 py-3">
      <ProviderSelectionSummary {...summaryProps} />
      <div data-testid="assistant-model-dropdown">
        <ModelPicker
          models={pickerModels}
          providers={pickerProviders}
          {...(modelName ? { value: modelName } : {})}
          disabled={options.length === 0 || !onModelChange}
          mode="single"
          modelType="llm"
          onChange={handleModelPickerChange}
          placeholder={options.length === 0 ? 'No models enabled' : 'Select a model...'}
        />
      </div>
    </div>
  );
};

type ProviderSelectionSummaryProps = {
  provider: ProviderOptionConfig | undefined;
  model: ProviderModelOptionConfig | undefined;
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
};

const ProviderSelectionSummary: FC<ProviderSelectionSummaryProps> = ({
  provider,
  model,
  selectedProvider,
  selectedModel,
}) => {
  if (!(provider && selectedProvider)) {
    return (
      <div className="rounded-md border border-border/70 border-dashed bg-background px-3 py-2 text-muted-foreground text-xs">
        Select a provider and model to start chatting.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
      <div>
        <p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
          In use
        </p>
        <p className="font-medium text-sm leading-tight">{provider.name}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
        <Badge variant="secondary">{model?.label ?? selectedModel ?? 'Select a model'}</Badge>
        {model?.supportsStreaming && <Badge variant="outline">Streaming</Badge>}
        {model?.type === 'embedding' && model.supportsStandardDimension && (
          <Badge variant="outline">768D</Badge>
        )}
      </div>
    </div>
  );
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
