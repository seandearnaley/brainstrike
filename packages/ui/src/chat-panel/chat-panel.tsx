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

// Tool event renderer component to reduce complexity
interface ToolEventProps {
  name: string;
  status: string;
  payload: unknown;
}

interface FileListItem {
  name: string;
  type: string;
}

interface EchoPayload {
  echo?: unknown;
  text?: unknown;
}

interface FileReadPayload {
  path?: string;
  size?: number;
  content?: string;
  truncated?: boolean;
}

interface JsonPreviewProps {
  obj: unknown;
  expanded: boolean;
  onToggle: () => void;
  enableCopy?: boolean;
}

const JsonPreview: React.FC<JsonPreviewProps> = ({ obj, expanded, onToggle, enableCopy }) => {
  try {
    const text = JSON.stringify(obj, null, 2);
    const trim = !expanded && text.length > 400 ? `${text.slice(0, 400)}…` : text;
    return (
      <div className="mt-1">
        <pre
          className="text-[11px] whitespace-pre-wrap break-words"
          data-testid="tool-part-details"
        >
          {trim}
        </pre>
        <div className="flex items-center gap-2 mt-1">
          {text.length > 400 && (
            <button
              type="button"
              className="text-[11px] opacity-80 hover:opacity-100 underline"
              onClick={onToggle}
              data-testid="tool-json-toggle"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {enableCopy ? (
            <CopyButton value={text} ariaLabel="Copy JSON" dataTestId="tool-json-copy" />
          ) : null}
        </div>
      </div>
    );
  } catch {
    return null;
  }
};

interface FileListToolProps {
  payload: FileListItem[];
}

const FileListTool: React.FC<FileListToolProps> = ({ payload }) => (
  <div className="mt-1 text-[11px]">
    <div className="opacity-70">Items:</div>
    <ul className="list-disc ml-4">
      {payload.slice(0, 5).map((f) => (
        <li key={f.name}>
          <span>{f.name}</span>
          <span className="opacity-60"> ({f.type})</span>
        </li>
      ))}
      {payload.length > 5 && <li className="opacity-60">… and {payload.length - 5} more</li>}
    </ul>
  </div>
);

interface EchoToolProps {
  payload: EchoPayload;
}

const EchoTool: React.FC<EchoToolProps> = ({ payload }) => (
  <div className="mt-1 text-[11px] opacity-80">
    {(payload.echo ? String(payload.echo) : null) ?? (payload.text ? String(payload.text) : '')}
  </div>
);

interface FileReadToolProps {
  payload: FileReadPayload;
  expanded: boolean;
  onToggleExpanded: () => void;
}

const FileReadTool: React.FC<FileReadToolProps> = ({ payload, expanded, onToggleExpanded }) => (
  <div className="mt-1 text-[11px]">
    <div className="opacity-70">
      {payload.path ?? ''} — {payload.size ?? 0} bytes
      {payload.truncated ? ' (truncated)' : ''}
    </div>
    <div className="mt-1 border rounded bg-muted/20">
      <pre className="p-2 text-[11px] overflow-x-auto max-h-40">
        {(() => {
          const c = payload.content ?? '';
          if (!expanded && c.length > 400) return `${c.slice(0, 400)}…`;
          return c;
        })()}
      </pre>
      {(payload.content ?? '').length > 400 && (
        <button
          type="button"
          className="w-full text-[11px] py-1 opacity-80 hover:opacity-100"
          onClick={onToggleExpanded}
          data-testid="tool-payload-toggle"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="px-2 pb-2">
        <CopyButton
          value={String(payload.content ?? '')}
          ariaLabel="Copy result"
          dataTestId="tool-result-copy"
        />
      </div>
    </div>
  </div>
);

interface ToolEventDetection {
  isFsList: boolean;
  isEcho: boolean;
  isFsRead: boolean;
  isFsSearch: boolean;
}

function detectToolEventType(name: string, payload: unknown): ToolEventDetection {
  const isFsList = name === 'filesystem.list' && Array.isArray(payload);

  const isEcho = Boolean(
    name === 'web.echo' &&
      payload &&
      typeof payload === 'object' &&
      ('text' in (payload as Record<string, unknown>) ||
        'echo' in (payload as Record<string, unknown>))
  );

  const isFsRead = Boolean(
    name === 'filesystem.read' &&
      payload &&
      typeof payload === 'object' &&
      'content' in (payload as Record<string, unknown>)
  );

  const isFsSearch = name === 'filesystem.search' && Array.isArray(payload);

  return {
    isFsList: Boolean(isFsList),
    isEcho,
    isFsRead,
    isFsSearch: Boolean(isFsSearch),
  };
}

function extractProgressData(payload: unknown) {
  const p = payload as Record<string, unknown>;
  return {
    step: typeof p['step'] === 'string' ? (p['step'] as string) : undefined,
    percent: typeof p['percent'] === 'number' ? (p['percent'] as number) : undefined,
    note: typeof p['note'] === 'string' ? (p['note'] as string) : undefined,
  };
}

function renderProgressLine(step?: string, percent?: number, note?: string): React.ReactNode {
  return (
    <div
      className="mt-1 text-[11px] opacity-80 text-blue-700 flex items-center gap-1"
      data-testid="tool-progress-line"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"
      />
      <span>{step ?? 'Progress'}</span>
      {typeof percent === 'number' ? <span>{` (${Math.round(percent)}%)`}</span> : null}
      {note ? <span>{` — ${note}`}</span> : null}
    </div>
  );
}

function renderProgressDetails(
  status: string,
  payload: unknown,
  expanded: boolean
): React.ReactNode {
  if (status === 'progress') {
    const { step, percent, note } = extractProgressData(payload);

    if (step || typeof percent === 'number' || note) {
      return renderProgressLine(step, percent, note);
    }
  }
  return (
    <JsonPreview
      obj={payload}
      expanded={expanded}
      onToggle={() => {
        /* handled by parent */
      }}
    />
  );
}

function renderSuccessPayload(
  detection: ToolEventDetection,
  payload: unknown,
  expanded: boolean,
  onToggleExpanded: () => void
): React.ReactNode {
  if (detection.isFsList) {
    return <FileListTool payload={payload as FileListItem[]} />;
  }

  if (detection.isEcho && payload) {
    return <EchoTool payload={payload as EchoPayload} />;
  }

  if (detection.isFsRead && payload) {
    return (
      <FileReadTool
        payload={payload as FileReadPayload}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
      />
    );
  }

  if (detection.isFsSearch) {
    return (
      <div className="mt-1 text-[11px]">
        <div className="opacity-70">Matches:</div>
        <ul className="list-disc ml-4">
          {(payload as Array<{ name: string; path: string; type: string }>).slice(0, 5).map((f) => (
            <li key={f.path}>
              <span>{f.name}</span>
              <span className="opacity-60"> ({f.type})</span>
            </li>
          ))}
          {Array.isArray(payload) && (payload as unknown[]).length > 5 && (
            <li className="opacity-60">… and {(payload as unknown[]).length - 5} more</li>
          )}
        </ul>
      </div>
    );
  }

  return <JsonPreview obj={payload} expanded={expanded} onToggle={onToggleExpanded} enableCopy />;
}

const statusToBadge: Record<string, string> = {
  start: 'bg-blue-100 text-blue-800',
  progress: 'bg-amber-100 text-amber-800',
  success: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
};

const ToolEventCard: React.FC<ToolEventProps> = ({ name, status, payload }) => {
  const [expanded, setExpanded] = useState(false);
  const detection = detectToolEventType(name, payload);

  const errorText =
    payload && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)
      ? String((payload as { error?: unknown }).error)
      : null;

  const handleToggleExpanded = () => setExpanded((v) => !v);

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-medium">{name}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${statusToBadge[status] ?? 'bg-gray-100 text-gray-800'}`}
        >
          {status}
        </span>
      </div>

      {/* Progress/start details */}
      {(status === 'start' || status === 'progress') && payload && typeof payload === 'object' && (
        <div className="mt-1">
          {renderProgressDetails(status, payload, expanded)}
          <div className="mt-1">
            <CopyButton
              value={safeStringify(payload)}
              ariaLabel="Copy args"
              dataTestId="tool-args-copy"
            />
          </div>
        </div>
      )}

      {/* Success payloads */}
      {status === 'success' && (
        <div className="mt-1">
          {renderSuccessPayload(detection, payload, expanded, handleToggleExpanded)}
        </div>
      )}

      {/* Error copy */}
      {status === 'error' && errorText && (
        <div className="mt-1 text-[11px] text-destructive">Error: {String(errorText)}</div>
      )}
    </>
  );
};

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

interface CopyButtonProps {
  value: string;
  ariaLabel: string;
  dataTestId?: string;
}

function CopyButton({ value, ariaLabel, dataTestId }: CopyButtonProps): React.ReactElement {
  function copyValue(): void {
    const electronClipboard = (
      window as unknown as {
        clipboard?: { writeText?: (t: string) => boolean };
      }
    ).clipboard;
    if (typeof electronClipboard?.writeText === 'function') {
      const ok = electronClipboard.writeText(String(value ?? ''));
      if (ok) return;
    }
    void navigator.clipboard.writeText(String(value ?? ''));
  }
  return (
    <button
      type="button"
      className="text-[11px] opacity-80 hover:opacity-100 underline"
      onClick={copyValue}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      Copy
    </button>
  );
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ className, transport, runtime }) => {
  const [input, setInput] = useState('');
  const lastSendRef = useRef<{ text: string; ts: number } | null>(null);
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

  const prepareAgentMessages = useCallback(
    (
      messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
      text: string,
      userId: string
    ) => {
      const agentMessages = messages
        .map((m) =>
          m.role === 'user'
            ? {
                id: m.id,
                role: 'user' as const,
                parts: [{ type: 'text' as const, text: m.content }],
              }
            : null
        )
        .filter(Boolean) as Array<{
        id: string;
        role: 'user';
        parts: Array<{ type: 'text'; text: string }>;
      }>;

      agentMessages.push({
        id: userId,
        role: 'user',
        parts: [{ type: 'text', text }],
      });

      return agentMessages;
    },
    []
  );

  const processStreamChunk = useCallback(
    (chunk: StreamChunk, assistantId: string) => {
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
    },
    [appendAssistantDelta, doScrollToEnd]
  );

  const handleSendText = useCallback(
    async (textRaw: string) => {
      const text = textRaw.trim();
      if (!text || isStreaming) return;

      // Guard against rapid duplicate sends
      const now = Date.now();
      if (
        lastSendRef.current &&
        lastSendRef.current.text === text &&
        now - lastSendRef.current.ts < 1000
      ) {
        return;
      }

      // Setup UI state
      setInput('');
      setLastPrompt(text);
      const user = buildUserMessage(text);
      addUserMessage({ id: user.id, role: 'user', content: text });
      const assistantId = generateUUID();
      startAssistantMessage(assistantId);
      doScrollToEnd();
      setToolEvents([]);

      try {
        const agentMessages = prepareAgentMessages(messages, text, user.id);
        const iterable = await activeTransport(agentMessages, runtime);
        currentIterableRef.current = iterable;

        for await (const chunk of iterable) {
          processStreamChunk(chunk, assistantId);
        }
      } catch {
        appendAssistantDelta(assistantId, '\n[error] failed to stream response');
      } finally {
        finishStreaming();
        currentIterableRef.current = null;
        lastSendRef.current = { text, ts: Date.now() };
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
      prepareAgentMessages,
      processStreamChunk,
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

  function renderTextSegment(segment: string, index: number): React.ReactNode {
    return segment ? <span key={`t-${index}`}>{segment}</span> : null;
  }

  function renderCodeBlock(segment: string, index: number): React.ReactNode {
    const nl = segment.indexOf('\n');
    const lang: string = nl >= 0 ? segment.slice(0, nl).trim() : 'text';
    const code: string = nl >= 0 ? segment.slice(nl + 1) : segment;

    function copyCode(): void {
      const electronClipboard = (
        window as unknown as {
          clipboard?: { writeText?: (t: string) => boolean };
        }
      ).clipboard;
      if (typeof electronClipboard?.writeText === 'function') {
        const ok = electronClipboard.writeText(String(code));
        if (ok) return;
      }
      void navigator.clipboard.writeText(String(code));
    }

    return (
      <div
        key={`code-${index}`}
        className="relative group border rounded bg-muted/40 my-1"
        data-testid="code-block"
      >
        <button
          type="button"
          className="absolute right-2 top-1 text-[10px] opacity-80 hover:opacity-100"
          onClick={copyCode}
          aria-label="Copy code"
          data-testid="copy-code"
        >
          Copy
        </button>
        <pre className="overflow-x-auto p-2 text-[11px]" data-language={lang || 'text'}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  function renderContentWithCodeBlocks(text: string) {
    if (!text.includes('```')) return [<span key="t-0">{text}</span>];

    const chunks: string[] = text.split('```');
    const nodes: React.ReactNode[] = [];

    chunks.forEach((segment, i) => {
      if (!segment && i % 2 === 0) return;

      const node = i % 2 === 0 ? renderTextSegment(segment, i) : renderCodeBlock(segment, i);

      if (node) nodes.push(node);
    });

    return nodes;
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
                  {renderContentWithCodeBlocks(m.content)}
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
                      <ToolEventCard name={t.name} status={t.status} payload={t.payload} />
                    </div>
                  ))}
                </div>
              )}
              <div ref={listEndRef} />
            </div>
          </ScrollArea>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">
                Try: <code>list files in ~</code>, <code>read file ./README.md</code>,
                <code> search files md in ./docs</code>
              </div>
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
