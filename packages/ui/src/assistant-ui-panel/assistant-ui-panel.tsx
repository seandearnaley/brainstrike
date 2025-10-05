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
import { Button } from '../button';
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

export interface AssistantUiPanelProps {
  className?: string;
  providers?: ProviderConfig[];
  selectedProvider?: string;
  selectedModel?: string;
  onProviderChange?: (provider: string) => void;
  onModelChange?: (model: string) => void;
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
  selectedProvider,
  selectedModel,
  onProviderChange,
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

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const availableModels = currentProvider?.models ?? [];
  const isComposerDisabled = Boolean(disabled);
  const providerSelectDisabled = providers.length === 0;
  const modelSelectDisabled = !selectedProvider || availableModels.length === 0;

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
          {providers.length > 0 && (
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
                      {availableModels.map((model: string) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
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

AssistantUiPanel.displayName = 'AssistantUiPanel';
