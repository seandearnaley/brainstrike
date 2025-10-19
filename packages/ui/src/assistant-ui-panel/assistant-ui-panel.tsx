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
import { type FC, useEffect, useState } from 'react';
import '@assistant-ui/styles/index.css';
import '@assistant-ui/styles/markdown.css';
import './overrides.css';
import { Badge } from '../badge';
import { Button } from '../button';
import { Checkbox } from '../checkbox';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
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
  onProviderChange?: (provider: string) => void;
  onModelChange?: (model: string) => void;
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
  providers = [],
  providerGroups,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  onModelToggle,
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

  const runtime = useDataStreamRuntime({
    api,
    body: {
      data: {
        provider: selectedProvider,
        model: selectedModel,
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
          {hasGroupedProviders ? (
            <ProviderGroupsHeader
              groups={groupedProviders}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
              onModelToggle={onModelToggle}
            />
          ) : providers.length > 0 ? (
            <LegacyProviderHeader
              providers={providers}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onProviderChange={onProviderChange}
              onModelChange={onModelChange}
            />
          ) : null}
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

interface ProviderGroupsHeaderProps {
  groups: ProviderGroupConfig[];
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onProviderChange?: ((provider: string) => void) | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  onModelToggle?: ((provider: string, model: string, enabled: boolean) => void) | undefined;
}

const ProviderGroupsHeader: FC<ProviderGroupsHeaderProps> = ({
  groups,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  onModelToggle,
}) => {
  const visibleGroups = groups.filter((group) => group.providers.length > 0);
  if (visibleGroups.length === 0) {
    return null;
  }

  return (
    <div className="flex-shrink-0 px-3 py-3 border-b border-border bg-muted/30 space-y-3">
      {visibleGroups.map((group) => (
        <div
          key={group.runtime}
          className="space-y-2"
          data-testid={`assistant-provider-group-${group.runtime}`}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label ?? RUNTIME_LABELS[group.runtime]}
          </p>
          <div className="flex flex-col gap-2">
            {group.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                selectedProvider={selectedProvider}
                selectedModel={selectedModel}
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                onModelToggle={onModelToggle}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

interface ProviderCardProps {
  provider: ProviderOptionConfig;
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onProviderChange?: ((provider: string) => void) | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  onModelToggle?: ((provider: string, model: string, enabled: boolean) => void) | undefined;
}

const ProviderCard: FC<ProviderCardProps> = ({
  provider,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  onModelToggle,
}) => {
  const isSelected = provider.id === selectedProvider;
  const enabledCount = provider.models.filter((model) => model.enabled).length;
  const radioId = `assistant-provider-${provider.id}`;

  const handleProviderChange = () => {
    onProviderChange?.(provider.id);
  };

  return (
    <div
      className={cn(
        'rounded-md border bg-background p-3 transition-colors',
        isSelected ? 'border-primary bg-primary/5' : 'border-border'
      )}
      data-testid={`assistant-provider-card-${provider.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            id={radioId}
            type="radio"
            name="assistant-provider"
            className="h-4 w-4 cursor-pointer accent-primary"
            checked={isSelected}
            onChange={handleProviderChange}
            disabled={!onProviderChange}
            aria-label={`Select ${provider.name}`}
            data-testid={`assistant-provider-radio-${provider.id}`}
          />
          <label
            htmlFor={radioId}
            className={cn(
              'cursor-pointer select-none',
              isSelected ? 'text-foreground' : 'text-foreground'
            )}
          >
            <span className="text-sm font-medium leading-none">{provider.name}</span>
            <p className="text-xs text-muted-foreground">
              {enabledCount === 1 ? '1 model enabled' : `${enabledCount} models enabled`}
            </p>
          </label>
        </div>
        <ProviderCapabilityBadges provider={provider} />
      </div>

      <div className="mt-3 space-y-1" data-testid={`assistant-provider-models-${provider.id}`}>
        {provider.models.map((model) => (
          <ProviderModelRow
            key={model.id}
            providerId={provider.id}
            model={model}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            onModelToggle={onModelToggle}
          />
        ))}
      </div>
    </div>
  );
};

const ProviderCapabilityBadges: FC<{ provider: ProviderOptionConfig }> = ({ provider }) => {
  const { capabilities } = provider;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {capabilities.llm && <Badge variant="secondary">Chat</Badge>}
      {capabilities.embeddings && (
        <Badge variant={capabilities.supportsStandardEmbeddingDimension ? 'secondary' : 'outline'}>
          {capabilities.supportsStandardEmbeddingDimension ? 'Embeddings · 768D' : 'Embeddings'}
        </Badge>
      )}
      {capabilities.streaming && <Badge variant="outline">Streaming</Badge>}
    </div>
  );
};

interface ProviderModelRowProps {
  providerId: string;
  model: ProviderModelOptionConfig;
  selectedModel?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  onModelToggle?: ((provider: string, model: string, enabled: boolean) => void) | undefined;
}

const ProviderModelRow: FC<ProviderModelRowProps> = ({
  providerId,
  model,
  selectedModel,
  onModelChange,
  onModelToggle,
}) => {
  const checkboxId = `assistant-model-toggle-${providerId}-${model.id}`;
  const isSelected = selectedModel === model.id;

  const handleToggle = (checked: boolean | 'indeterminate') => {
    if (!onModelToggle) return;
    onModelToggle(providerId, model.id, checked === true);
  };

  const handleSelect = () => {
    if (!model.enabled || !onModelChange) return;
    onModelChange(model.id);
  };

  const typeBadgeLabel = model.type === 'llm' ? 'LLM' : 'Embedding';

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border px-2 py-1 transition-colors',
        model.enabled
          ? 'border-border/60 bg-background'
          : 'border-dashed border-border/40 bg-muted/20',
        isSelected && model.enabled ? 'border-primary bg-primary/10' : null
      )}
      data-testid={`assistant-model-row-${providerId}-${model.id}`}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={model.enabled}
          onCheckedChange={handleToggle}
          disabled={!onModelToggle}
          aria-label={`Toggle ${model.label}`}
          data-testid={`assistant-model-toggle-${providerId}-${model.id}`}
        />
        <button
          type="button"
          onClick={handleSelect}
          disabled={!model.enabled || !onModelChange}
          className={cn(
            'flex items-center gap-2 text-sm font-medium leading-snug transition-colors',
            model.enabled && onModelChange
              ? 'text-foreground hover:text-primary'
              : 'text-muted-foreground',
            isSelected && model.enabled
              ? 'underline decoration-primary decoration-2 underline-offset-4'
              : null
          )}
          data-testid={`assistant-model-select-${providerId}-${model.id}`}
        >
          <span>{model.label}</span>
          {model.default && <Badge variant="outline">Default</Badge>}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
        <Badge variant="outline">{typeBadgeLabel}</Badge>
        {model.supportsStreaming && <Badge variant="outline">Streaming</Badge>}
        {model.type === 'embedding' && model.supportsStandardDimension && (
          <Badge variant="outline">768D</Badge>
        )}
      </div>
    </div>
  );
};

interface LegacyProviderHeaderProps {
  providers: ProviderConfig[];
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onProviderChange?: ((provider: string) => void) | undefined;
  onModelChange?: ((model: string) => void) | undefined;
}

const LegacyProviderHeader: FC<LegacyProviderHeaderProps> = ({
  providers,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
}) => {
  if (providers.length === 0) {
    return null;
  }

  const currentProvider = providers.find((provider) => provider.id === selectedProvider);
  const availableModels = currentProvider?.models ?? [];

  const providerSelectDisabled = providers.length === 0;
  const modelSelectDisabled = !selectedProvider || availableModels.length === 0;

  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-border bg-muted/30">
      <div className="flex gap-2 items-center">
        {onProviderChange && (
          <Select
            value={selectedProvider ?? ''}
            onValueChange={onProviderChange}
            disabled={providerSelectDisabled}
          >
            <SelectTrigger
              className="w-36 h-8 text-sm"
              data-testid="assistant-provider-select"
              aria-label="Select AI provider"
              disabled={providerSelectDisabled}
            >
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {onModelChange && (
          <Select
            value={selectedModel ?? ''}
            onValueChange={onModelChange}
            disabled={modelSelectDisabled}
          >
            <SelectTrigger
              className="w-52 h-8 text-sm"
              data-testid="assistant-model-select"
              aria-label="Select model"
              disabled={modelSelectDisabled}
            >
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
