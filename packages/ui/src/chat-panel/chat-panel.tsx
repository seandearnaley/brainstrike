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
import type {
  CancellableIterable,
  ChatTransport,
  RuntimeData,
  StreamChunk,
} from './chat-transport';
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
  const currentIterableRef = useRef<CancellableIterable<StreamChunk> | null>(null);
  const [toolEvents, setToolEvents] = useState<
    Array<{ id: string; name: string; status: string; payload?: unknown }>
  >([]);
  const [lastPrompt, setLastPrompt] = useState<string>('');

  const doScrollToEnd = useCallback(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const activeTransport = useMemo(() => transport ?? defaultWebTransport, [transport]);

  const handleSendText = useCallback(
    async (textRaw: string) => {
      const text = textRaw.trim();
      if (!text || isStreaming) return;
      setInput('');
      setLastPrompt(text);
      const user = buildUserMessage(text);
      addUserMessage({ id: user.id, role: 'user', content: text });
      const assistantId = generateUUID();
      startAssistantMessage(assistantId);
      doScrollToEnd();
      setToolEvents([]);
      try {
        // Map to minimal agent message form
        const agentMessages: {
          id: string;
          role: 'user';
          parts: { type: 'text'; text: string }[];
        }[] = messages
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
        currentIterableRef.current = iterable;
        for await (const chunk of iterable) {
          if (chunk.type === 'text-delta') {
            appendAssistantDelta(assistantId, chunk.value);
          } else if (chunk.type === 'tool-event') {
            setToolEvents((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${prev.length}`,
                name: chunk.name,
                status: chunk.status,
                payload: chunk.payload,
              },
            ]);
          }
          doScrollToEnd();
        }
      } catch (_e) {
        appendAssistantDelta(assistantId, '\n[error] failed to stream response');
      } finally {
        finishStreaming();
        currentIterableRef.current = null;
        doScrollToEnd();
      }
    },
    [
      activeTransport,
      addUserMessage,
      appendAssistantDelta,
      doScrollToEnd,
      finishStreaming,
      isStreaming,
      messages,
      runtime,
      startAssistantMessage,
    ]
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    await handleSendText(text);
  }, [handleSendText, input, isStreaming]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  const handleStop = useCallback(() => {
    currentIterableRef.current?.cancel?.();
    finishStreaming();
  }, [finishStreaming]);

  const handleRetry = useCallback(() => {
    if (isStreaming) return;
    const candidate = lastPrompt || [...messages].reverse().find((m) => m.role === 'user')?.content;
    if (candidate) void handleSendText(candidate);
  }, [handleSendText, isStreaming, lastPrompt, messages]);

  function escapeHtml(str: string) {
    return str
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function renderContentWithCodeBlocks(text: string) {
    const parts: React.ReactNode[] = [];
    const regex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const [full, lang, codeMaybe] = match;
      const start = match.index;
      if (start > lastIndex) {
        const plain = text.slice(lastIndex, start);
        parts.push(<span key={`t-${start}`}>{plain}</span>);
      }
      const code = codeMaybe ?? '';
      const _safeCode = escapeHtml(code);
      const language = (lang ?? 'text').toLowerCase();
      const codeKey = `code-${start}`;
      parts.push(
        <div
          key={codeKey}
          className="relative group border rounded bg-muted/40"
          data-testid="code-block"
        >
          <button
            type="button"
            className="absolute right-2 top-1 text-[10px] opacity-80 hover:opacity-100"
            onClick={() => navigator.clipboard.writeText(code)}
            aria-label="Copy code"
            data-testid="copy-code"
          >
            Copy
          </button>
          <pre className="overflow-x-auto p-2 text-[11px]" data-language={language}>
            <code>{code}</code>
          </pre>
        </div>
      );
      lastIndex = start + full.length;
      match = regex.exec(text);
    }
    if (lastIndex < text.length) parts.push(<span key={'t-end'}>{text.slice(lastIndex)}</span>);
    return parts;
  }

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
                  <span>{renderContentWithCodeBlocks(m.content)}</span>
                </div>
              ))}
              {toolEvents.length > 0 && (
                <div className="space-y-1">
                  {toolEvents.map((t) => (
                    <div
                      key={t.id}
                      className="border rounded px-2 py-1 bg-muted/30"
                      data-testid="tool-part"
                      data-tool={t.name}
                    >
                      <span className="font-medium mr-1">{t.name}</span>
                      <span className="mr-1">—</span>
                      <span className="text-[11px]">{t.status}</span>
                    </div>
                  ))}
                </div>
              )}
              <div ref={listEndRef} />
            </div>
          </ScrollArea>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
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
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleRetry}
                disabled={isStreaming}
                aria-label="Retry"
              >
                Retry
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleStop}
                disabled={!isStreaming}
                aria-label="Stop"
              >
                Stop
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

ChatPanel.displayName = 'ChatPanel';
