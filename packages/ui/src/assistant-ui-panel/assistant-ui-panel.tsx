import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import { useDataStreamRuntime } from '@assistant-ui/react-data-stream';
import { type FC, useEffect, useState } from 'react';
import '@assistant-ui/styles/index.css';
import '@assistant-ui/styles/markdown.css';
import './overrides.css';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { MarkdownText } from './markdown-text';

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
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="aui-assistant-message-root">
                    <div className="aui-assistant-message-content">
                      <div className="aui-assistant-message-label text-[11px] opacity-70 mb-1">
                        Assistant:
                      </div>
                      <MessagePrimitive.Parts
                        components={{
                          /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
                          Text: MarkdownText,
                        }}
                      />
                    </div>
                    <ActionBarPrimitive.Root
                      autohide="not-last"
                      hideWhenRunning
                      className="aui-assistant-action-bar-root"
                    >
                      <ActionBarPrimitive.Reload
                        aria-label="Retry"
                        className="aui-button aui-button-ghost aui-button-icon"
                      />
                    </ActionBarPrimitive.Root>
                  </MessagePrimitive.Root>
                ),
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                UserMessage: () => (
                  <MessagePrimitive.Root className="aui-user-message-root">
                    <div className="aui-user-message-content">
                      <div className="aui-user-message-label text-[11px] opacity-70 mb-1">You:</div>
                      <MessagePrimitive.Parts
                        components={{
                          /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
                          Text: MarkdownText,
                        }}
                      />
                    </div>
                  </MessagePrimitive.Root>
                ),
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

AssistantUiPanel.displayName = 'AssistantUiPanel';
