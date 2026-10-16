import { Square } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Live QA 2026-10-16: a conversation's background subagents still working at
 * its composer. Between the conversation's own runs nothing else says they
 * run, and its composer offers no Stop, so this names them and stops the ones
 * the owner says it can (`stoppable`). While the conversation's own run is
 * active, its Stop already ends that turn's children; a child from an earlier
 * turn stays stoppable here.
 */
export function SubagentsRunningStrip({
  onStop,
  owners,
  stoppable,
}: {
  /** Stops the `stoppable` subagents through the conversation's owner. */
  readonly onStop: () => Promise<void>;
  /** The working subagents' call signs, in delegation order. */
  readonly owners: readonly string[];
  /** The call signs `onStop` ends; empty when the running turn's Stop owns them all. */
  readonly stoppable: readonly string[];
}): ReactElement | null {
  const [stopping, setStopping] = useState(false);
  // A refusal is about the subagents it tried to stop, so it shows while any of them still runs.
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly targets: readonly string[];
  }>();
  if (owners.length === 0) {
    return null;
  }
  const count = owners.length;
  const noun = count === 1 ? 'subagent' : 'subagents';
  const stopNoun = stoppable.length === 1 ? 'subagent' : 'subagents';
  const error = failure?.targets.some((owner) => stoppable.includes(owner))
    ? failure.message
    : undefined;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    setStopping(true);
    setFailure(undefined);
    onStop()
      .catch((cause: unknown) => setFailure({ message: errorText(cause), targets: stoppable }))
      .finally(() => setStopping(false));
  };
  return (
    <div
      aria-live="polite"
      className="bs-subagents-running"
      data-testid="subagents-running-strip"
      role="status"
    >
      <BrainstrikeThinkingMark className="size-3.5" testId="subagents-running-mark" />
      <span className="bs-subagents-running-label" title={owners.join(', ')}>
        {count} {noun} running
      </span>
      {stoppable.length > 0 ? (
        <button
          aria-label={`Stop ${stoppable.length} running ${stopNoun}`}
          className="bs-subagents-running-stop"
          data-testid="subagents-running-stop"
          disabled={stopping}
          onClick={stop}
          title={stoppable.join(', ')}
          type="button"
        >
          <Square aria-hidden="true" className="size-2.5" fill="currentColor" />
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      ) : null}
      {error === undefined ? null : <span role="alert">{error}</span>}
    </div>
  );
}
