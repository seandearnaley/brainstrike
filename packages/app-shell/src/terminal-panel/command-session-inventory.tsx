import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import { Button } from '@brainstrike/ui';
import { CircleStop, RefreshCw, Send, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { useCommandSessionBridge } from '../workspace-terminal-services';
import type { CommandSessionInfo } from './command-session-bridge';

const MAX_DISPLAY_CHARS = 128 * 1024;

function sessionTitle(session: CommandSessionInfo): string {
  const segments = session.cwd.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? 'Command session';
}

function shortSessionId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

interface CommandSessionInventoryProps {
  readonly rootId: string;
}

export function CommandSessionInventory({ rootId }: CommandSessionInventoryProps): ReactElement {
  const bridge = useCommandSessionBridge();
  const cursorRef = useRef<number | undefined>(undefined);
  const readRequestVersionRef = useRef(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [output, setOutput] = useState('');
  const [outputOmitted, setOutputOmitted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [sessions, setSessions] = useState<readonly CommandSessionInfo[]>([]);

  const readSession = async (sessionId: string, nextCursor?: number): Promise<void> => {
    if (!bridge) {
      setError('Command-session controls are unavailable in this runtime.');
      return;
    }
    const requestVersion = readRequestVersionRef.current + 1;
    readRequestVersionRef.current = requestVersion;
    const result = await bridge.read({
      rootId,
      sessionId,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    });
    if (selectedIdRef.current !== sessionId || readRequestVersionRef.current !== requestVersion) {
      return;
    }
    if (!result.ok) {
      setError(describeBoundaryFailure(result.error));
      return;
    }
    setError(undefined);
    setHasMore(result.value.hasMore);
    setSessions((current) =>
      current.map((session) =>
        session.id === result.value.session.id ? result.value.session : session
      )
    );
    cursorRef.current = result.value.nextCursor;
    setOutput((current) => {
      const combined =
        nextCursor === undefined ? result.value.output : `${current}${result.value.output}`;
      if (combined.length <= MAX_DISPLAY_CHARS) {
        return combined;
      }
      setOutputOmitted(true);
      return combined.slice(-MAX_DISPLAY_CHARS);
    });
    if (result.value.truncatedBeforeCursor) {
      setOutputOmitted(true);
    }
  };

  const refresh = async (): Promise<void> => {
    if (!bridge) {
      setError('Command-session controls are unavailable in this runtime.');
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await bridge.list({ rootId });
    if (!result.ok) {
      setError(describeBoundaryFailure(result.error));
      setLoading(false);
      return;
    }
    setError(undefined);
    setSessions(result.value.sessions);
    const previousSelected = selectedIdRef.current;
    const selected = result.value.sessions.some((session) => session.id === previousSelected)
      ? previousSelected
      : result.value.sessions[0]?.id;
    const selectionChanged = selected !== previousSelected;
    setSelectedId(selected);
    selectedIdRef.current = selected;
    if (selectionChanged) {
      cursorRef.current = undefined;
      setHasMore(false);
      setOutput('');
      setOutputOmitted(false);
    }
    if (selected) {
      await readSession(selected, selectionChanged ? undefined : cursorRef.current);
    }
    setLoading(false);
  };

  useEffect(() => {
    const refreshTimer = globalThis.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      globalThis.clearTimeout(refreshTimer);
    };
  }, [refresh]);

  function selectSession(sessionId: string): void {
    selectedIdRef.current = sessionId;
    cursorRef.current = undefined;
    setSelectedId(sessionId);
    setError(undefined);
    setHasMore(false);
    setOutput('');
    setOutputOmitted(false);
    void readSession(sessionId);
  }

  async function stopSelected(): Promise<void> {
    if (!(bridge && selectedId)) {
      return;
    }
    const result = await bridge.stop({ rootId, sessionId: selectedId });
    if (!result.ok) {
      setError(describeBoundaryFailure(result.error));
      return;
    }
    await refresh();
  }

  async function removeSelected(): Promise<void> {
    if (!(bridge && selectedId)) {
      return;
    }
    const result = await bridge.remove({ rootId, sessionId: selectedId });
    if (!result.ok) {
      setError(describeBoundaryFailure(result.error));
      return;
    }
    selectedIdRef.current = undefined;
    cursorRef.current = undefined;
    setOutput('');
    await refresh();
  }

  async function sendInput(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!(bridge && selectedId) || input.length === 0) {
      return;
    }
    const result = await bridge.write({ data: `${input}\n`, rootId, sessionId: selectedId });
    if (!result.ok) {
      setError(describeBoundaryFailure(result.error));
      return;
    }
    setInput('');
  }

  const selected = sessions.find((session) => session.id === selectedId);

  return (
    <div className="bg-background grid h-full min-h-0 grid-cols-[minmax(12rem,18rem)_1fr]">
      <aside className="border-border flex min-h-0 flex-col border-r">
        <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
          <div>
            <p className="text-sm font-medium">Command sessions</p>
            <p className="text-muted-foreground text-xs">Assistant-owned processes</p>
          </div>
          <Button
            aria-label="Refresh command sessions"
            disabled={loading}
            onClick={() => void refresh()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 && !loading ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              No command sessions in this workspace.
            </p>
          ) : null}
          {sessions.map((session) => (
            <button
              className={`mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                selectedId === session.id
                  ? 'border-primary/40 bg-primary/10'
                  : 'hover:bg-muted/70 border-transparent'
              }`}
              key={session.id}
              onClick={() => selectSession(session.id)}
              type="button"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{sessionTitle(session)}</span>
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    session.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/50'
                  }`}
                />
              </span>
              <span className="text-muted-foreground mt-1 block truncate font-mono text-[11px]">
                {shortSessionId(session.id)} · PID {session.pid}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        {selected ? (
          <>
            <header className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{sessionTitle(selected)}</p>
                <p className="text-muted-foreground truncate font-mono text-[11px]">
                  {selected.id} · root {selected.rootId} · {selected.status}
                  {selected.status === 'exited' ? ` · exit ${selected.exitCode}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {selected.status === 'running' ? (
                  <Button
                    onClick={() => void stopSelected()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <CircleStop aria-hidden="true" className="mr-1" /> Stop
                  </Button>
                ) : null}
                <Button
                  onClick={() => void removeSelected()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" className="mr-1" /> Remove
                </Button>
              </div>
            </header>
            {error ? (
              <p className="border-destructive/30 bg-destructive/10 text-destructive border-b px-3 py-2 text-xs">
                {error}
              </p>
            ) : null}
            {outputOmitted ? (
              <p className="border-border text-warning border-b px-3 py-1.5 text-xs">
                Older output is no longer available in this view.
              </p>
            ) : null}
            <pre
              aria-label="Command session output"
              className="min-h-0 flex-1 overflow-auto bg-black/95 p-3 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-zinc-100"
              role="log"
            >
              {output || 'Waiting for output…'}
            </pre>
            {hasMore ? (
              <Button
                className="rounded-none border-x-0 border-b-0"
                onClick={() => selectedId && void readSession(selectedId, cursorRef.current)}
                size="sm"
                type="button"
                variant="outline"
              >
                Load more output
              </Button>
            ) : null}
            {selected.status === 'running' ? (
              <form className="border-border flex gap-2 border-t p-2" onSubmit={sendInput}>
                <input
                  aria-label="Command session input"
                  className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:ring-2"
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Send input"
                  value={input}
                />
                <Button disabled={input.length === 0} size="sm" type="submit">
                  <Send aria-hidden="true" className="mr-1" /> Send
                </Button>
              </form>
            ) : null}
          </>
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
            {error ?? 'Select a command session to inspect its output.'}
          </div>
        )}
      </section>
    </div>
  );
}
