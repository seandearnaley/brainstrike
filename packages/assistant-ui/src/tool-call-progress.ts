import { formatActivityDuration } from './tool-durations';

/**
 * Lifecycle of a tool call's ARGUMENTS, as assistant-stream's
 * `AssistantMessageAccumulator` records it on the part it builds:
 * `partial-call` while the model is still streaming argument text, `call` once
 * `tool-call-args-text-finish` lands, `result` after the tool result.
 */
export type ToolCallArgsState = 'partial-call' | 'call' | 'result';

/**
 * Reads the accumulator's `state` off a tool-call part.
 *
 * The renderer receives the accumulated part spread whole into its props, so
 * `state` is present at runtime — but `@assistant-ui/core`'s public
 * `ToolCallMessagePart` type does not declare it, and the field that IS typed
 * for the purpose (`status.isArgsComplete`) is written `false` at part creation
 * and never flipped by the installed accumulator, so it cannot carry the
 * signal. Narrowed rather than cast; an absent or unrecognised value yields
 * `undefined` so the card falls back to plain "Running" instead of claiming
 * input is still arriving. Pinned against the installed accumulator in
 * `__tests__/tool-call-args-state.contract.test.ts`.
 */
export function readToolCallArgsState(part: unknown): ToolCallArgsState | undefined {
  if (!(part && typeof part === 'object' && 'state' in part)) {
    return;
  }
  const state = part.state;
  return state === 'partial-call' || state === 'call' || state === 'result' ? state : undefined;
}

const encoder = new TextEncoder();

/** UTF-8 byte length — what actually crossed the wire, not UTF-16 code units. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

const KIB = 1024;
const MIB = KIB * KIB;

/** `812 B`, `12.4 KB`, `1.3 MB` — one decimal above bytes so a live counter visibly moves. */
export function formatByteCount(bytes: number): string {
  if (bytes < KIB) {
    return `${Math.max(0, Math.round(bytes))} B`;
  }
  if (bytes < MIB) {
    return `${(bytes / KIB).toFixed(1)} KB`;
  }
  return `${(bytes / MIB).toFixed(1)} MB`;
}

export interface ToolCallProgressInput {
  /** Bytes of argument text received so far. */
  readonly argsByteLength: number;
  /** True while the model is still streaming the arguments (`partial-call`). */
  readonly argsStreaming: boolean;
  /** Wall-clock time since the call opened, when the runtime recorded one. */
  readonly elapsedMs: number | undefined;
}

/**
 * The in-flight tool row's label (BST-849).
 *
 * A large tool input can take minutes to stream, and until it finishes the
 * card used to sit on a static "Thinking" — indistinguishable from a hung run,
 * which is exactly how the original report was misdiagnosed. The label now
 * derives from what the stream already delivers: the received byte count
 * while arguments are still arriving, and the elapsed time from the part's
 * timing. Sub-second elapsed values are withheld: the timer ticks once a
 * second, so showing `420ms` would only flicker.
 *
 * "Receiving input" is claimed only once bytes have actually arrived. A part
 * opens as `partial-call` before its first delta, and a producer that never
 * streams argument text (a zero-argument tool, a call delivered whole) may
 * leave it there for the whole execution — `Receiving input · 0 B` would then
 * assert the opposite of what is happening. Bytes received ⇒ input arriving
 * is the only claim the label can make truthfully.
 */
export function describeToolCallProgress({
  argsByteLength,
  argsStreaming,
  elapsedMs,
}: ToolCallProgressInput): string {
  const segments =
    argsStreaming && argsByteLength > 0
      ? ['Receiving input', formatByteCount(argsByteLength)]
      : ['Running'];
  if (elapsedMs !== undefined && elapsedMs >= 1000) {
    segments.push(formatActivityDuration(elapsedMs));
  }
  return segments.join(' · ');
}
