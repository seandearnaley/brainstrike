import { useEffect, useMemo, useState } from 'react';
import {
  describeToolCallProgress,
  readToolCallArgsState,
  utf8ByteLength,
} from './tool-call-progress';

export interface ToolCallTimingLike {
  readonly completedAt?: number | undefined;
  readonly startedAt: number;
}

/**
 * Elapsed wall-clock time for a tool call, from the `timing` assistant-stream
 * stamps on the part (`startedAt` when the call opens, `completedAt` with the
 * result). Ticks once per second while the call is still running so the
 * in-flight row visibly moves; freezes to the recorded span once complete.
 * `undefined` when the runtime recorded no timing (older persisted threads) —
 * never a fabricated clock.
 *
 * Keyed on the timing PRIMITIVES rather than the object: the accumulator
 * spreads the part on every argument delta, and a re-armed interval per delta
 * would reset the tick phase dozens of times a second.
 */
export function useToolCallElapsedMs(
  timing: ToolCallTimingLike | undefined,
  isRunning: boolean
): number | undefined {
  const startedAt = timing?.startedAt;
  const completedAt = timing?.completedAt;
  const ticking = isRunning && startedAt !== undefined && completedAt === undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const intervalId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, [ticking]);

  if (startedAt === undefined) {
    return;
  }
  if (completedAt !== undefined) {
    return Math.max(0, completedAt - startedAt);
  }
  if (!ticking) {
    return;
  }
  return Math.max(0, now - startedAt);
}

export interface ToolCallProgressSource {
  /** Raw argument text streamed so far — the LIVE value, not a remembered one. */
  readonly argsText: string | undefined;
  readonly timing?: ToolCallTimingLike | undefined;
}

/**
 * The in-flight tool row's live label (BST-849): received bytes while the
 * model is still streaming the arguments, elapsed time off the part timing.
 * `part` is the whole tool-call part as the renderer receives it, so the
 * accumulator's `state` can be read off it.
 */
export function useToolCallProgressLabel(
  part: ToolCallProgressSource,
  isRunning: boolean
): { readonly argsStreaming: boolean; readonly label: string } {
  const argsStreaming = isRunning && readToolCallArgsState(part) === 'partial-call';
  const elapsedMs = useToolCallElapsedMs(part.timing, isRunning);
  const argsText = part.argsText ?? '';
  const argsByteLength = useMemo(() => utf8ByteLength(argsText), [argsText]);
  return {
    argsStreaming,
    label: describeToolCallProgress({ argsByteLength, argsStreaming, elapsedMs }),
  };
}
