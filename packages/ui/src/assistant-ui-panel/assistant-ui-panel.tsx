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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../select';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { TooltipIconButton } from './tooltip-icon-button';

export interface ProviderConfig {
  id: string;
  name: string;
  models: readonly string[];
  defaultModel: string;
}

export type ProviderRuntimeCategory = 'hosted' | 'gateway' | 'local' | 'browser';

export interface ProviderModelOptionConfig {
  id: string;
  label: string;
  type: 'llm' | 'embedding';
  enabled: boolean;
  default?: boolean;
  supportsStreaming?: boolean;
  supportsStandardDimension?: boolean;
}

export interface ProviderOptionConfig {
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
}

export interface ProviderGroupConfig {
  runtime: ProviderRuntimeCategory;
  label: string;
  providers: ProviderOptionConfig[];
}

export interface AssistantUiPanelProps {
  className?: string;
  providers?: ProviderConfig[];
  providerGroups?: ProviderGroupConfig[];
  selectedProvider?: string;
  selectedModel?: string;
  onModelChange?: (compositeKey: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}

declare global {
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

export const AssistantUiPanel: FC<AssistantUiPanelProps> = ({
  providerGroups,
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
        if (url) setApi(`${url}/assistant`);
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
    if (!selectedModel) return undefined;
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
      className="flex flex-col h-full min-h-0"
      data-testid="chat-panel"
      aria-label="Assistant chat"
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="aui-root aui-thread-root bs-thread flex flex-col h-full min-h-0">
          {/* Provider and Model Selector Header */}
          {hasGroupedProviders && (
            <ProviderModelHeader
              groups={groupedProviders}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
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
            className="aui-thread-viewport"
            data-testid="assistant-ui-viewport"
            aria-live="polite"
            aria-atomic="false"
          >
            {disabledReason && (
              <p className="px-4 py-3 text-xs text-muted-foreground" aria-live="polite">
                {disabledReason}
              </p>
            )}
            <ThreadPrimitive.Messages
              components={{
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                AssistantMessage: AssistantMessage,
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                UserMessage: UserMessage,
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                EditComposer: EditComposer,
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
          <div className="flex-shrink-0 border-t border-border bg-background">
            <ComposerPrimitive.Root
              className="aui-composer-root"
              aria-disabled={isComposerDisabled}
              data-disabled={isComposerDisabled ? '' : undefined}
            >
              <ComposerPrimitive.Input
                rows={1}
                placeholder="Ask the assistant…"
                className="aui-composer-input"
                id="assistant-input"
                aria-label="Message input"
                disabled={isComposerDisabled}
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

      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="col-start-1 row-start-2 mr-3 mt-2 flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" aria-label="Edit message">
          <PencilIcon className="size-4" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <ComposerPrimitive.Root className="my-4 flex w-full flex-col gap-2 rounded-xl bg-muted">
      <ComposerPrimitive.Input className="flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none" />

      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button size="sm">Send</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative grid w-full grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-3">
      <div className="aui-assistant-message-content col-span-2 col-start-2 row-start-1 my-1.5 max-w-xl break-words leading-7 text-foreground">
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

      <BranchPicker className="col-start-2 row-start-2 -ml-2 mr-2" />
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" aria-label="Copy message">
          <MessagePrimitive.If copied>
            <CheckIcon className="size-4" />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon className="size-4" />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Retry" aria-label="Regenerate response">
          <RefreshCwIcon className="size-4" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

const BranchPicker: FC<{ className?: string }> = ({ className }) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={`inline-flex items-center text-xs text-muted-foreground ${className ?? ''}`}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous" aria-label="Previous branch">
          <ChevronLeftIcon className="size-4" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next" aria-label="Next branch">
          <ChevronRightIcon className="size-4" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

const RUNTIME_LABELS: Record<ProviderRuntimeCategory, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

interface ProviderModelOption {
  value: string;
  provider: ProviderOptionConfig;
  model: ProviderModelOptionConfig;
  groupLabel: string;
}

interface NormalizedProviderGroup {
  runtime: ProviderRuntimeCategory;
  label: string;
  providers: Array<{
    provider: ProviderOptionConfig;
    models: ProviderModelOptionConfig[];
  }>;
}

interface ProviderModelHeaderProps {
  groups: ProviderGroupConfig[];
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
}

const ProviderModelHeader: FC<ProviderModelHeaderProps> = ({
  groups,
  selectedProvider,
  selectedModel,
  onModelChange,
}) => {
  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) return undefined;
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  const normalizedGroups = useMemo<NormalizedProviderGroup[]>(() => {
    return groups
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
      .filter((group): group is NormalizedProviderGroup => group !== null);
  }, [groups]);

  const options = useMemo<ProviderModelOption[]>(() => {
    return normalizedGroups.flatMap((group) =>
      group.providers.flatMap((entry) =>
        entry.models.map((model) => ({
          value: `${entry.provider.id}::${model.id}`,
          provider: entry.provider,
          model,
          groupLabel: group.label,
        }))
      )
    );
  }, [normalizedGroups]);

  const selectedOption = useMemo<ProviderModelOption | undefined>(() => {
    return options.find(
      (option) => option.provider.id === selectedProvider && option.model.id === modelName
    );
  }, [options, modelName, selectedProvider]);

  const [pendingValue, setPendingValue] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingValue) {
      return;
    }
    const optionMatch = options.find((option) => option.value === pendingValue);
    if (
      optionMatch &&
      optionMatch.provider.id === selectedProvider &&
      optionMatch.model.id === modelName
    ) {
      setPendingValue(null);
    }
  }, [options, pendingValue, modelName, selectedProvider]);

  const selectValue = pendingValue ?? selectedOption?.value ?? '';
  const placeholder = options.length === 0 ? 'No models enabled' : 'Select a model';

  const handleSelectChange = useCallback(
    (value: string) => {
      setPendingValue(value);
      // value is composite key: "provider::model"
      onModelChange?.(value);
    },
    [onModelChange]
  );

  const summaryProps: ProviderSelectionSummaryProps = {
    provider: selectedOption?.provider,
    model: selectedOption?.model,
    selectedProvider,
    selectedModel,
  };

  return (
    <div className="flex-shrink-0 space-y-3 border-b border-border bg-muted/30 px-3 py-3">
      <ProviderSelectionSummary {...summaryProps} />
      <Select
        value={selectValue}
        onValueChange={handleSelectChange}
        disabled={options.length === 0 || !onModelChange}
      >
        <SelectTrigger
          className="h-9"
          data-testid="assistant-model-dropdown"
          aria-label="Select AI model"
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {normalizedGroups.map((group, groupIndex) => (
            <div key={`${group.runtime}-${groupIndex}`}>
              <SelectGroup>
                <SelectLabel>{group.label}</SelectLabel>
                {group.providers.flatMap((entry) =>
                  entry.models.map((model) => {
                    const value = `${entry.provider.id}::${model.id}`;
                    return (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`assistant-model-option-${entry.provider.id}-${model.id}`}
                      >
                        <div className="flex flex-col">
                          <span>{model.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {entry.provider.name}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })
                )}
              </SelectGroup>
              {groupIndex < normalizedGroups.length - 1 ? <SelectSeparator /> : null}
            </div>
          ))}
          {normalizedGroups.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Enable models in settings to choose them here.
            </div>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
};

interface ProviderSelectionSummaryProps {
  provider: ProviderOptionConfig | undefined;
  model: ProviderModelOptionConfig | undefined;
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
}

const ProviderSelectionSummary: FC<ProviderSelectionSummaryProps> = ({
  provider,
  model,
  selectedProvider,
  selectedModel,
}) => {
  if (!provider || !selectedProvider) {
    return (
      <div className="rounded-md border border-dashed border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
        Select a provider and model to start chatting.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          In use
        </p>
        <p className="text-sm font-medium leading-tight">{provider.name}</p>
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
