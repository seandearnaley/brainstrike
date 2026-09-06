import { useEffect, useState } from 'react';
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
 *
 * The clock is seeded lazily at mount and advanced ONLY from the interval —
 * no synchronous setState inside the effect (the compiler's
 * `set-state-in-effect` diagnostic). The card mounts with the part the
 * accumulator opens, so the seed and `startedAt` are the same instant; the
 * label withholds sub-second values anyway, so nothing is lost before the
 * first tick.
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

interface ByteCount {
  readonly bytes: number;
  readonly text: string;
}

const EMPTY_BYTE_COUNT: ByteCount = { bytes: 0, text: '' };

function advanceByteCount(previous: ByteCount, text: string): ByteCount {
  // The accumulator only ever APPENDS argument text, so the common step is
  // "encode the new suffix". A text that is not an extension (a different
  // call's part re-mounting into the same card, a reload) is recounted whole.
  const bytes =
    text.length >= previous.text.length && text.startsWith(previous.text)
      ? previous.bytes + utf8ByteLength(text.slice(previous.text.length))
      : utf8ByteLength(text);
  return { bytes, text };
}

/**
 * UTF-8 byte length of a string that grows by appends, in O(total) rather
 * than O(n²): re-encoding the whole accumulated argument text on every delta
 * would allocate a fresh copy of a multi-megabyte input dozens of times a
 * second, on the same frame budget as the streaming render.
 *
 * The running count is carried as state adjusted during render (React's
 * "storing information from previous renders" pattern) rather than a ref
 * mutated in render, so the hook stays pure for the compiler.
 */
export function useIncrementalUtf8ByteLength(text: string): number {
  const [count, setCount] = useState<ByteCount>(EMPTY_BYTE_COUNT);
  if (count.text === text) {
    return count.bytes;
  }
  const next = advanceByteCount(count, text);
  setCount(next);
  return next.bytes;
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
  const argsByteLength = useIncrementalUtf8ByteLength(part.argsText ?? '');
  return {
    argsStreaming,
    label: describeToolCallProgress({ argsByteLength, argsStreaming, elapsedMs }),
  };
}
