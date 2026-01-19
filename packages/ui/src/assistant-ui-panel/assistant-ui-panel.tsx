import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
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
// @assistant-ui/styles v0.3.x consolidated all styles into index.css
import '@assistant-ui/styles/index.css';
import './overrides.css';
import { Badge } from '../badge';
import { Button } from '../button';
import { Input } from '../input';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { ModelPicker } from '../model-picker';
import type { ModelPickerModel, ModelPickerProvider } from '../model-picker/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { Switch } from '../switch';
import { createLocalModelAdapter, disposeLocalBackend } from './local-runtime-adapter';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { TooltipIconButton } from './tooltip-icon-button';

// Re-export types needed by consumers
export type { ModelPickerModel, ModelPickerProvider };

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

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';
export type AnthropicEffort = 'low' | 'medium' | 'high';
export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface AssistantProviderSettings {
  maxOutputTokens?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  anthropicEffort?: AnthropicEffort;
  anthropicThinkingBudgetTokens?: number;
  googleThinkingLevel?: GoogleThinkingLevel;
  googleIncludeThoughts?: boolean;
}

export type AssistantProviderSettingsUpdate = {
  [Key in keyof AssistantProviderSettings]?: AssistantProviderSettings[Key] | undefined;
};

export type AssistantProviderSettingsMap = Record<string, AssistantProviderSettings>;

export interface AssistantUiPanelProps {
  className?: string;
  providers?: ProviderConfig[];
  providerGroups?: ProviderGroupConfig[];
  /** Models for the ModelPicker component */
  pickerModels: ModelPickerModel[];
  /** Providers for the ModelPicker component */
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider?: string;
  selectedModel?: string;
  onModelChange?: (compositeKey: string) => void;
  onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  requestData?: Record<string, unknown>;
}

declare global {
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

// Local model loading state for progress display
interface LocalModelLoadingState {
  stage: 'downloading' | 'loading' | 'ready' | 'error';
  progress: number;
  message: string;
  file?: string;
}

// Shared props for inner chat components
interface ChatThreadProps {
  providerGroups: ProviderGroupConfig[];
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider: string | undefined;
  selectedModel: string | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  disabled: boolean;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
}

/**
 * Inner component for local runtime (browser-based inference).
 * Uses useLocalRuntime with LocalLlmBackend via transformers.js.
 */
const LocalRuntimeChat: FC<
  ChatThreadProps & {
    modelId: string;
    onLoadingStateChange: (state: LocalModelLoadingState) => void;
  }
> = ({
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  disabled,
  disabledReason,
  localLoadingState,
  modelId,
  onLoadingStateChange,
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);

  // Create adapter with memoization to avoid re-creating on every render
  const adapter = useMemo(
    () =>
      createLocalModelAdapter({
        modelId,
        onLoadingProgress: (progress: LocalModelLoadingState) => {
          onLoadingStateChange(progress);
        },
        onError: (error: Error) => {
          onLoadingStateChange({
            stage: 'error',
            progress: 0,
            message: error.message,
          });
        },
      }),
    [modelId, onLoadingStateChange]
  );

  const runtime = useLocalRuntime(adapter);

  // Cleanup on unmount
  useEffect(
    () => () => {
      void disposeLocalBackend();
    },
    []
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThreadUI
        disabledReason={disabledReason}
        hasGroupedProviders={hasGroupedProviders}
        isComposerDisabled={isComposerDisabled}
        localLoadingState={localLoadingState}
        onModelChange={onModelChange}
        onProviderSettingsChange={onProviderSettingsChange}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        providerGroups={providerGroups}
        providerSettings={providerSettings}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
      />
    </AssistantRuntimeProvider>
  );
};

/**
 * Inner component for data stream runtime (server-side hosted providers).
 * Uses useDataStreamRuntime for API-based inference.
 */
const DataStreamRuntimeChat: FC<
  ChatThreadProps & {
    api: string;
    requestData: Record<string, unknown> | undefined;
    modelName: string | undefined;
  }
> = ({
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  disabled,
  disabledReason,
  api,
  requestData,
  modelName,
}) => {
  const hasGroupedProviders = providerGroups.length > 0;
  const isComposerDisabled = Boolean(disabled);

  const runtime = useDataStreamRuntime({
    api,
    body: {
      data: {
        ...(requestData ?? {}),
        provider: selectedProvider,
        model: modelName,
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatThreadUI
        disabledReason={disabledReason}
        hasGroupedProviders={hasGroupedProviders}
        isComposerDisabled={isComposerDisabled}
        onModelChange={onModelChange}
        onProviderSettingsChange={onProviderSettingsChange}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        providerGroups={providerGroups}
        providerSettings={providerSettings}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
      />
    </AssistantRuntimeProvider>
  );
};

/**
 * Shared UI component for the chat thread.
 * Extracted to avoid duplication between local and data stream runtimes.
 */
const ChatThreadUI: FC<{
  providerGroups: ProviderGroupConfig[];
  hasGroupedProviders: boolean;
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider: string | undefined;
  selectedModel: string | undefined;
  onModelChange: ((compositeKey: string) => void) | undefined;
  isComposerDisabled: boolean;
  disabledReason: string | undefined;
  localLoadingState?: LocalModelLoadingState | undefined;
}> = ({
  providerGroups,
  hasGroupedProviders,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  onModelChange,
  isComposerDisabled,
  disabledReason,
  localLoadingState,
}) => (
  <ThreadPrimitive.Root className="aui-root aui-thread-root bs-thread flex h-full min-h-0 flex-col">
    {/* Provider and Model Selector Header */}
    {hasGroupedProviders && (
      <ProviderModelHeader
        groups={providerGroups}
        onModelChange={onModelChange}
        onProviderSettingsChange={onProviderSettingsChange}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        providerSettings={providerSettings}
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
      {/* Local model loading indicator */}
      {localLoadingState && localLoadingState.stage !== 'ready' && (
        <div className="px-4 py-3 text-xs">
          <div className="mb-1 font-medium text-muted-foreground">
            {localLoadingState.stage === 'downloading' && 'Downloading model...'}
            {localLoadingState.stage === 'loading' && 'Loading model...'}
            {localLoadingState.stage === 'error' && 'Error loading model'}
          </div>
          {localLoadingState.stage !== 'error' && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round(localLoadingState.progress * 100)}%` }}
              />
            </div>
          )}
          <p className="mt-1 text-muted-foreground">
            {localLoadingState.message}
            {localLoadingState.file && ` (${localLoadingState.file})`}
          </p>
        </div>
      )}
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
);

export const AssistantUiPanel: FC<AssistantUiPanelProps> = ({
  className,
  providerGroups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
  selectedProvider,
  selectedModel,
  requestData,
  onModelChange,
  disabled = false,
  disabledReason,
}) => {
  // API URL for data stream runtime (hosted providers)
  const initialApi =
    typeof window === 'undefined'
      ? '/api/assistant'
      : window.assistant?.url
        ? `${window.assistant.url}/assistant`
        : '/api/assistant';
  const [api, setApi] = useState<string>(initialApi);

  // Local model loading state
  const [localLoadingState, setLocalLoadingState] = useState<LocalModelLoadingState | undefined>();

  // biome-ignore lint/plugin: Async API URL resolution on mount - standard initialization
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

  // Extract model name from composite key (format: "provider::model")
  const modelName = useMemo(() => {
    if (!selectedModel) {
      return;
    }
    const parts = selectedModel.split('::');
    return parts.length === 2 ? parts[1] : selectedModel;
  }, [selectedModel]);

  // Check if using local provider
  const isLocalProvider = selectedProvider === 'local';

  // Handler for local model loading state updates
  const handleLocalLoadingStateChange = useCallback((state: LocalModelLoadingState) => {
    setLocalLoadingState(state);
  }, []);

  return (
    <section
      aria-label="Assistant chat"
      className={cn('assistant-ui-panel flex h-full min-h-0 flex-col', className)}
      data-testid="chat-panel"
    >
      {isLocalProvider && modelName ? (
        <LocalRuntimeChat
          disabled={disabled}
          disabledReason={disabledReason}
          localLoadingState={localLoadingState}
          modelId={modelName}
          onLoadingStateChange={handleLocalLoadingStateChange}
          onModelChange={onModelChange}
          onProviderSettingsChange={onProviderSettingsChange}
          pickerModels={pickerModels}
          pickerProviders={pickerProviders}
          providerGroups={groupedProviders}
          providerSettings={providerSettings}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
        />
      ) : (
        <DataStreamRuntimeChat
          api={api}
          disabled={disabled}
          disabledReason={disabledReason}
          modelName={modelName}
          onModelChange={onModelChange}
          onProviderSettingsChange={onProviderSettingsChange}
          pickerModels={pickerModels}
          pickerProviders={pickerProviders}
          providerGroups={groupedProviders}
          providerSettings={providerSettings}
          requestData={requestData}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
        />
      )}
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

      <BranchPicker className="col-start-2 row-start-2 mr-2 -ml-2" />
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    autohide="not-last"
    autohideFloat="single-branch"
    className="col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm"
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
  pickerModels: ModelPickerModel[];
  pickerProviders: ModelPickerProvider[];
  providerSettings?: AssistantProviderSettingsMap | undefined;
  onProviderSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  onModelChange?: ((compositeKey: string) => void) | undefined;
}

const ProviderModelHeader: FC<ProviderModelHeaderProps> = ({
  groups,
  pickerModels,
  pickerProviders,
  providerSettings,
  onProviderSettingsChange,
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
      <ProviderSettingsPanel
        modelName={modelName}
        onSettingsChange={onProviderSettingsChange}
        providerId={selectedProvider}
        settings={selectedProvider ? providerSettings?.[selectedProvider] : undefined}
      />
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

const settingsNumberFormatter = new Intl.NumberFormat();

const MAX_OUTPUT_DEFAULT = 2048;
const MAX_OUTPUT_MIN = 128;
const MAX_OUTPUT_MAX = 8192;
const MAX_OUTPUT_STEP = 64;

const ANTHROPIC_THINKING_DEFAULT = 12_000;
const ANTHROPIC_THINKING_MIN = 1024;
const ANTHROPIC_THINKING_MAX = 20_000;
const ANTHROPIC_THINKING_STEP = 256;

const OPENAI_EFFORT_OPTIONS: Array<{ value: OpenAiReasoningEffort | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto (medium)' },
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

const OPENAI_SUMMARY_OPTIONS: Array<{
  value: OpenAiReasoningSummary | 'off';
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'detailed', label: 'Detailed' },
];

const ANTHROPIC_EFFORT_OPTIONS: Array<{ value: AnthropicEffort | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto (high)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const GOOGLE_FLASH_THINKING_LEVELS: GoogleThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
const GOOGLE_PRO_THINKING_LEVELS: GoogleThinkingLevel[] = ['low', 'high'];

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function parseNumber(value: string): number | undefined {
  if (!value.trim()) {
    return;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ProviderSettingsPanelProps {
  providerId?: string | undefined;
  modelName?: string | undefined;
  settings?: AssistantProviderSettings | undefined;
  onSettingsChange?:
    | ((providerId: string, updates: AssistantProviderSettingsUpdate) => void)
    | undefined;
}

type ProviderSettingsUpdate = (updates: AssistantProviderSettingsUpdate) => void;

interface ProviderSettingsSectionProps {
  settings: AssistantProviderSettings;
  onUpdate: ProviderSettingsUpdate;
  disabled: boolean;
}

const MaxOutputSection: FC<ProviderSettingsSectionProps> = ({ settings, onUpdate, disabled }) => {
  const maxOutputEnabled = typeof settings.maxOutputTokens === 'number';
  const maxOutputValue = clampNumber(
    settings.maxOutputTokens ?? MAX_OUTPUT_DEFAULT,
    MAX_OUTPUT_MIN,
    MAX_OUTPUT_MAX
  );

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Max output tokens
        </Label>
        <Switch
          checked={maxOutputEnabled}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onUpdate({
              maxOutputTokens: checked ? maxOutputValue : undefined,
            })
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          disabled={disabled || !maxOutputEnabled}
          inputMode="numeric"
          max={MAX_OUTPUT_MAX}
          min={MAX_OUTPUT_MIN}
          onChange={(event) => {
            const parsed = parseNumber(event.target.value);
            if (parsed === undefined) {
              onUpdate({ maxOutputTokens: undefined });
              return;
            }
            onUpdate({
              maxOutputTokens: clampNumber(parsed, MAX_OUTPUT_MIN, MAX_OUTPUT_MAX),
            });
          }}
          placeholder="Auto"
          type="number"
          value={maxOutputEnabled ? maxOutputValue : ''}
        />
        <span className="text-[10px] text-muted-foreground">
          {maxOutputEnabled ? settingsNumberFormatter.format(maxOutputValue) : 'Auto'}
        </span>
      </div>
      <input
        aria-label="Max output tokens"
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
        disabled={disabled || !maxOutputEnabled}
        max={MAX_OUTPUT_MAX}
        min={MAX_OUTPUT_MIN}
        onChange={(event) =>
          onUpdate({
            maxOutputTokens: clampNumber(
              Number(event.target.value),
              MAX_OUTPUT_MIN,
              MAX_OUTPUT_MAX
            ),
          })
        }
        step={MAX_OUTPUT_STEP}
        type="range"
        value={maxOutputEnabled ? maxOutputValue : MAX_OUTPUT_DEFAULT}
      />
    </div>
  );
};

const OpenAiReasoningSection: FC<ProviderSettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled,
}) => (
  <div className="space-y-2 rounded-md bg-muted/30 p-2">
    <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
      OpenAI reasoning
    </Label>
    <div className="grid gap-2">
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Effort</span>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate({
              reasoningEffort: value === 'auto' ? undefined : (value as OpenAiReasoningEffort),
            })
          }
          value={settings.reasoningEffort ?? 'auto'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Reasoning summary</span>
        <Select
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate({
              reasoningSummary: value === 'off' ? undefined : (value as OpenAiReasoningSummary),
            })
          }
          value={settings.reasoningSummary ?? 'off'}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_SUMMARY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  </div>
);

const AnthropicReasoningSection: FC<ProviderSettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled,
}) => {
  const thinkingEnabled = typeof settings.anthropicThinkingBudgetTokens === 'number';
  const thinkingValue = clampNumber(
    settings.anthropicThinkingBudgetTokens ?? ANTHROPIC_THINKING_DEFAULT,
    ANTHROPIC_THINKING_MIN,
    ANTHROPIC_THINKING_MAX
  );

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Claude reasoning
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Effort</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                anthropicEffort: value === 'auto' ? undefined : (value as AnthropicEffort),
              })
            }
            value={settings.anthropicEffort ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              {ANTHROPIC_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 rounded-md border border-border bg-background p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Thinking budget
            </span>
            <Switch
              checked={thinkingEnabled}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onUpdate({
                  anthropicThinkingBudgetTokens: checked ? thinkingValue : undefined,
                })
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 text-xs"
              disabled={disabled || !thinkingEnabled}
              inputMode="numeric"
              max={ANTHROPIC_THINKING_MAX}
              min={ANTHROPIC_THINKING_MIN}
              onChange={(event) => {
                const parsed = parseNumber(event.target.value);
                if (parsed === undefined) {
                  onUpdate({ anthropicThinkingBudgetTokens: undefined });
                  return;
                }
                onUpdate({
                  anthropicThinkingBudgetTokens: clampNumber(
                    parsed,
                    ANTHROPIC_THINKING_MIN,
                    ANTHROPIC_THINKING_MAX
                  ),
                });
              }}
              placeholder="Auto"
              type="number"
              value={thinkingEnabled ? thinkingValue : ''}
            />
            <span className="text-[10px] text-muted-foreground">
              {thinkingEnabled ? settingsNumberFormatter.format(thinkingValue) : 'Auto'}
            </span>
          </div>
          <input
            aria-label="Anthropic thinking budget"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-primary transition-all hover:bg-muted/80"
            disabled={disabled || !thinkingEnabled}
            max={ANTHROPIC_THINKING_MAX}
            min={ANTHROPIC_THINKING_MIN}
            onChange={(event) =>
              onUpdate({
                anthropicThinkingBudgetTokens: clampNumber(
                  Number(event.target.value),
                  ANTHROPIC_THINKING_MIN,
                  ANTHROPIC_THINKING_MAX
                ),
              })
            }
            step={ANTHROPIC_THINKING_STEP}
            type="range"
            value={thinkingEnabled ? thinkingValue : ANTHROPIC_THINKING_DEFAULT}
          />
        </div>
      </div>
    </div>
  );
};

interface GoogleThinkingSectionProps extends ProviderSettingsSectionProps {
  modelName?: string | undefined;
}

const GoogleThinkingSection: FC<GoogleThinkingSectionProps> = ({
  settings,
  onUpdate,
  disabled,
  modelName,
}) => {
  const isGeminiPro = Boolean(modelName?.includes('gemini-3-pro'));
  const googleThinkingLevels = isGeminiPro
    ? GOOGLE_PRO_THINKING_LEVELS
    : GOOGLE_FLASH_THINKING_LEVELS;

  return (
    <div className="space-y-2 rounded-md bg-muted/30 p-2">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Gemini thinking
      </Label>
      <div className="space-y-2">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground">Thinking level</span>
          <Select
            disabled={disabled}
            onValueChange={(value) =>
              onUpdate({
                googleThinkingLevel: value === 'auto' ? undefined : (value as GoogleThinkingLevel),
              })
            }
            value={settings.googleThinkingLevel ?? 'auto'}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {googleThinkingLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border bg-background p-2">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Include thoughts
            </p>
            <p className="text-[10px] text-muted-foreground">Stream internal reasoning (debug).</p>
          </div>
          <Switch
            checked={Boolean(settings.googleIncludeThoughts)}
            disabled={disabled}
            onCheckedChange={(checked) => onUpdate({ googleIncludeThoughts: checked })}
          />
        </div>
      </div>
    </div>
  );
};

const ProviderSettingsPanel: FC<ProviderSettingsPanelProps> = ({
  providerId,
  modelName,
  settings,
  onSettingsChange,
}) => {
  if (!providerId) {
    return null;
  }

  const normalizedProvider = providerId.toLowerCase();
  const isOpenAiFamily = normalizedProvider === 'openai' || normalizedProvider === 'openrouter';
  const isAnthropic = normalizedProvider === 'anthropic';
  const isGoogle = normalizedProvider === 'google';

  if (!(isOpenAiFamily || isAnthropic || isGoogle)) {
    return null;
  }

  const currentSettings = settings ?? {};
  const canUpdate = Boolean(onSettingsChange);
  const updateSettings: ProviderSettingsUpdate = (updates) => {
    if (!onSettingsChange) {
      return;
    }
    onSettingsChange(providerId, updates);
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Reasoning & Output
          </p>
          <p className="text-muted-foreground text-xs">
            Per-provider controls for reasoning depth and token limits.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MaxOutputSection
          disabled={!canUpdate}
          onUpdate={updateSettings}
          settings={currentSettings}
        />
        {isOpenAiFamily ? (
          <OpenAiReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isAnthropic ? (
          <AnthropicReasoningSection
            disabled={!canUpdate}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
        {isGoogle ? (
          <GoogleThinkingSection
            disabled={!canUpdate}
            modelName={modelName}
            onUpdate={updateSettings}
            settings={currentSettings}
          />
        ) : null}
      </div>
    </div>
  );
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
