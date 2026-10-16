import { Square } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Live QA 2026-10-16: a conversation's background subagents still working at
 * its composer. Between the conversation's own runs nothing else says they
 * run, and its composer offers no Stop, so this names them and — when the
 * owner passes `onStop` — stops them. The owner leaves `onStop` out while the
 * conversation's own run is active: its Stop already ends the turn's children.
 */
export function SubagentsRunningStrip({
  onStop,
  owners,
}: {
  /** Stops every working subagent through the conversation's owner. */
  readonly onStop?: (() => Promise<void>) | undefined;
  /** The working subagents' call signs, in delegation order. */
  readonly owners: readonly string[];
}): ReactElement | null {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  if (owners.length === 0) {
    return null;
  }
  const count = owners.length;
  const noun = count === 1 ? 'subagent' : 'subagents';
  const stop = (): void => {
    if (!onStop || stopping) {
      return;
    }
    setStopping(true);
    setError(undefined);
    onStop()
      .catch((cause: unknown) => setError(errorText(cause)))
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
      {onStop ? (
        <button
          aria-label={`Stop ${count} running ${noun}`}
          className="bs-subagents-running-stop"
          data-testid="subagents-running-stop"
          disabled={stopping}
          onClick={stop}
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
