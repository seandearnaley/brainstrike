import { generateUUID } from '@brainstrike/utils';
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '../button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../card';
import { Input } from '../input';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { ScrollArea } from '../scroll-area';
import type { ChatStore } from './chat-store';
import { chatSelectors, useChatStore } from './chat-store';
import type { ChatTransport, RuntimeData } from './chat-transport';
import { buildUserMessage, defaultWebTransport } from './chat-transport';

export interface ChatPanelProps {
  className?: string;
  transport?: ChatTransport;
  runtime?: RuntimeData;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ className, transport, runtime }) => {
  const [input, setInput] = useState('');
  const messages = useChatStore(chatSelectors.messages);
  const isStreaming = useChatStore(chatSelectors.isStreaming);
  const addUserMessage = useChatStore((s: ChatStore) => s.addUserMessage);
  const startAssistantMessage = useChatStore((s: ChatStore) => s.startAssistantMessage);
  const appendAssistantDelta = useChatStore((s: ChatStore) => s.appendAssistantDelta);
  const finishStreaming = useChatStore((s: ChatStore) => s.finishStreaming);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const doScrollToEnd = useCallback(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const activeTransport = useMemo(() => transport ?? defaultWebTransport, [transport]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    const user = buildUserMessage(text);
    addUserMessage({ id: user.id, role: 'user', content: text });
    const assistantId = generateUUID();
    startAssistantMessage(assistantId);
    doScrollToEnd();
    try {
      // Map to minimal agent message form
      const agentMessages: { id: string; role: 'user'; parts: { type: 'text'; text: string }[] }[] =
        messages
          .map((m: { id: string; role: 'user' | 'assistant'; content: string }) =>
            m.role === 'user'
              ? { id: m.id, role: 'user', parts: [{ type: 'text', text: m.content }] }
              : null
          )
          .filter(Boolean) as {
          id: string;
          role: 'user';
          parts: { type: 'text'; text: string }[];
        }[];
      const currentUser: { id: string; role: 'user'; parts: { type: 'text'; text: string }[] } = {
        id: user.id,
        role: 'user',
        parts: [{ type: 'text', text }],
      };
      agentMessages.push(currentUser);

      const iterable = await activeTransport(agentMessages, runtime);
      for await (const chunk of iterable) {
        if (chunk.type === 'text-delta') {
          appendAssistantDelta(assistantId, chunk.value);
          continue;
        }
        if (chunk.type === 'tool-event') {
          // For Phase 2, render a lightweight tool row via console or inline marker
          // We could extend UI to show these as separate rows later.
          // No-op UI side, kept for future richness.
        }
        doScrollToEnd();
      }
    } catch (_e) {
      appendAssistantDelta(assistantId, '\n[error] failed to stream response');
    } finally {
      finishStreaming();
      doScrollToEnd();
    }
  }, [
    activeTransport,
    addUserMessage,
    appendAssistantDelta,
    doScrollToEnd,
    finishStreaming,
    input,
    isStreaming,
    messages,
    runtime,
    startAssistantMessage,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className={cn('flex flex-col h-full', className)} data-testid="chat-panel">
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Assistant</CardTitle>
          <CardDescription className="text-xs">Ask questions about your project</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 h-[calc(100%-theme(spacing.12))]">
          <ScrollArea className="flex-1 border rounded p-2 text-xs">
            <div className="space-y-2">
              {messages.map((m: { id: string; role: 'user' | 'assistant'; content: string }) => (
                <div
                  key={m.id}
                  className={cn(
                    'whitespace-pre-wrap',
                    m.role === 'user' ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  <span className="font-medium mr-1">
                    {m.role === 'user' ? 'You:' : 'Assistant:'}
                  </span>
                  <span>{m.content}</span>
                </div>
              ))}
              <div ref={listEndRef} />
            </div>
          </ScrollArea>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="assistant-input">
                Message
              </Label>
              <Input
                id="assistant-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask the assistant…"
                className="text-xs"
              />
            </div>
            <Button
              type="button"
              onClick={() => void handleSend()}
              disabled={isStreaming}
              aria-label="Send"
            >
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

ChatPanel.displayName = 'ChatPanel';
