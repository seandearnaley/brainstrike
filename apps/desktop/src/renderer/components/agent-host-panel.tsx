import type { HostClient } from '@brainstrike/agent-host/browser';
import { CommittedThreadSession, foldHostRuns } from '@brainstrike/agent-host/thread-view';
import { createLogger } from '@brainstrike/logging';
import { Button } from '@brainstrike/ui';
import { type ReactElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

const logger = createLogger('AgentHostPanel');

export interface AgentHostPanelProps {
  readonly client: HostClient;
  readonly modelId: string;
  readonly threadId: string;
}

/** A client view of committed events. The host owns every run and tool decision. */
export function AgentHostPanel({ client, threadId, modelId }: AgentHostPanelProps): ReactElement {
  const session = useMemo(() => new CommittedThreadSession(client, threadId), [client, threadId]);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );
  const runs = foldHostRuns(snapshot.rows);
  const latest = runs.at(-1);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const connected = snapshot.connected;
  useEffect(() => {
    const disconnect = session.connect();
    return () => {
      // The client outlives this panel; a refused unsubscribe is reported, never swallowed.
      disconnect().catch((error: unknown) => {
        logger.error('Host panel unsubscribe failed', { error, threadId });
      });
    };
  }, [session, threadId]);
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setWorking(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  const busy = latest?.status === 'running';
  return (
    <section aria-label="Host assistant" className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="font-semibold text-lg">Assistant</h1>
        <output aria-label="Run status" aria-live="polite">
          {connected ? (latest?.status ?? 'ready') : 'disconnected'}
        </output>
        <Button
          disabled={!busy || working || !connected}
          onClick={() => {
            if (latest) {
              void perform(() =>
                client.request('run/stop', {
                  commandId: crypto.randomUUID(),
                  runId: latest.runId,
                  threadId,
                })
              );
            }
          }}
          variant="outline"
        >
          Stop
        </Button>
      </header>
      {(error ?? snapshot.error) && <p role="alert">{error ?? snapshot.error}</p>}
      <div aria-label="Assistant output" className="min-h-24 flex-1 whitespace-pre-wrap" role="log">
        {latest?.text}
      </div>
      {latest?.approvals.map((approval) => (
        <section
          aria-label="Tool approval"
          className="rounded border p-4"
          key={approval.interactionId}
        >
          <h2>Allow {approval.toolId}?</h2>
          <pre className="whitespace-pre-wrap">{JSON.stringify(approval.input, null, 2)}</pre>
          {(['approve', 'deny'] as const).map((decision) => (
            <Button
              disabled={working || !connected}
              key={decision}
              onClick={() => {
                void perform(() =>
                  client.request('interaction/respond', {
                    commandId: crypto.randomUUID(),
                    decision,
                    interactionId: approval.interactionId,
                    runId: approval.runId,
                    threadId,
                  })
                );
              }}
              variant={decision === 'deny' ? 'outline' : 'default'}
            >
              {decision === 'approve' ? 'Approve' : 'Deny'}
            </Button>
          ))}
        </section>
      ))}
      {latest?.results.map((result) => (
        <section aria-label="Tool result" key={result.toolCallId}>
          <pre className="whitespace-pre-wrap">{JSON.stringify(result.output, null, 2)}</pre>
        </section>
      ))}
      <form
        className="flex gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = prompt;
          void perform(async () => {
            await client.request('run/start', {
              commandId: crypto.randomUUID(),
              modelId,
              prompt: submitted,
              threadId,
            });
            setPrompt('');
          });
        }}
      >
        <textarea
          aria-label="Message"
          className="min-h-20 flex-1 rounded border p-2"
          disabled={busy || working || !connected}
          onChange={(event) => setPrompt(event.target.value)}
          value={prompt}
        />
        <Button disabled={busy || working || !connected || !prompt.trim()} type="submit">
          Send
        </Button>
      </form>
    </section>
  );
}
