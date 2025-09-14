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
import { MarkdownText } from './markdown-text';

export interface AssistantUiPanelProps {
  className?: string;
}

declare global {
  interface Window {
    assistant?: { getUrl?: () => Promise<string>; url?: string };
  }
}

export const AssistantUiPanel: FC<AssistantUiPanelProps> = ({ className }) => {
  const [api, setApi] = useState<string>(() =>
    window.assistant?.url ? `${window.assistant.url}/assistant` : '/api/assistant'
  );
  useEffect(() => {
    let mounted = true;

    const updateApi = async () => {
      try {
        const url = await window.assistant?.getUrl?.();
        if (url && mounted) setApi(`${url}/assistant`);
      } catch {
        // Ignore errors from getUrl
      }
    };

    void updateApi();

    return () => {
      mounted = false;
    };
  }, []);
  const runtime = useDataStreamRuntime({ api });

  return (
    <div className={className} data-testid="chat-panel">
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="aui-root aui-thread-root bs-thread">
          <ThreadPrimitive.Viewport className="aui-thread-viewport">
            <ThreadPrimitive.Messages
              components={{
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="aui-assistant-message-root">
                    <div className="aui-assistant-message-content">
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
                      <ActionBarPrimitive.Copy className="aui-button aui-button-ghost aui-button-icon" />
                      <ActionBarPrimitive.Reload className="aui-button aui-button-ghost aui-button-icon" />
                    </ActionBarPrimitive.Root>
                  </MessagePrimitive.Root>
                ),
                /* biome-ignore lint/style/useNamingConvention: assistant-ui component key */
                UserMessage: () => (
                  <MessagePrimitive.Root className="aui-user-message-root">
                    <div className="aui-user-message-content">
                      <MessagePrimitive.Parts />
                    </div>
                  </MessagePrimitive.Root>
                ),
              }}
            />
            <div className="aui-thread-viewport-footer">
              <ComposerPrimitive.Root className="aui-composer-root">
                <ComposerPrimitive.Input
                  rows={1}
                  placeholder="Ask the assistant…"
                  className="aui-composer-input"
                />
                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send className="aui-button aui-button-primary aui-composer-send">
                    Send
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel className="aui-button aui-button-primary aui-composer-cancel">
                    Stop
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </ComposerPrimitive.Root>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
};

AssistantUiPanel.displayName = 'AssistantUiPanel';
