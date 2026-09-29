import { describe, expect, it } from 'vitest';
import {
  describeToolCallProgress,
  formatByteCount,
  readToolCallArgsState,
  utf8ByteLength,
} from '../tool-call-progress';

describe('formatByteCount', () => {
  it('renders bytes, kilobytes and megabytes at the precision a live counter needs', () => {
    expect(formatByteCount(0)).toBe('0 B');
    expect(formatByteCount(812)).toBe('812 B');
    expect(formatByteCount(1024)).toBe('1.0 KB');
    expect(formatByteCount(3000)).toBe('2.9 KB');
    expect(formatByteCount(22_528)).toBe('22.0 KB');
    expect(formatByteCount(1_310_720)).toBe('1.3 MB');
  });
});

describe('utf8ByteLength', () => {
  it('counts encoded bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    // U+00E9 is two bytes; U+1F600 is four bytes (two code units).
    expect(utf8ByteLength('é😀')).toBe(6);
  });
});

describe('describeToolCallProgress', () => {
  it('reports the streamed argument size while the model is still sending input', () => {
    expect(
      describeToolCallProgress({ argsByteLength: 3000, argsStreaming: true, elapsedMs: undefined })
    ).toBe('Receiving input · 2.9 KB');
  });

  it('appends the elapsed time once a full second has passed', () => {
    expect(
      describeToolCallProgress({ argsByteLength: 22_528, argsStreaming: true, elapsedMs: 50_700 })
    ).toBe('Receiving input · 22.0 KB · 50.7s');
    expect(
      describeToolCallProgress({ argsByteLength: 0, argsStreaming: false, elapsedMs: 72_000 })
    ).toBe('Running · 1m 12s');
  });

  it('does not tick sub-second noise into the label', () => {
    expect(
      describeToolCallProgress({ argsByteLength: 40, argsStreaming: true, elapsedMs: 420 })
    ).toBe('Receiving input · 40 B');
    expect(
      describeToolCallProgress({ argsByteLength: 40, argsStreaming: false, elapsedMs: 999 })
    ).toBe('Running');
  });

  it('never claims input is arriving before a single byte has', () => {
    // A part sits in `partial-call` before its first delta, and a producer
    // that never streams argument text may leave it there for the whole run.
    expect(
      describeToolCallProgress({ argsByteLength: 0, argsStreaming: true, elapsedMs: 45_000 })
    ).toBe('Running · 45.0s');
  });

  it('reads as plain running once the arguments are complete and the tool executes', () => {
    expect(
      describeToolCallProgress({ argsByteLength: 512, argsStreaming: false, elapsedMs: undefined })
    ).toBe('Running');
  });
});

describe('readToolCallArgsState', () => {
  it('narrows the assistant-stream lifecycle state off an untyped part', () => {
    expect(readToolCallArgsState({ state: 'partial-call' })).toBe('partial-call');
    expect(readToolCallArgsState({ state: 'call' })).toBe('call');
    expect(readToolCallArgsState({ state: 'result' })).toBe('result');
  });

  it('returns undefined for an absent or unknown state rather than inventing one', () => {
    expect(readToolCallArgsState({})).toBeUndefined();
    expect(readToolCallArgsState({ state: 'streaming' })).toBeUndefined();
    expect(readToolCallArgsState({ state: 42 })).toBeUndefined();
    expect(readToolCallArgsState(null)).toBeUndefined();
  });
});
