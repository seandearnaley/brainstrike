// @vitest-environment node
import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { collectShellOutputs, createShellOutputAccumulator } from '../shell-output-parts';

// Mirrors the REAL data part the DataStreamMapper emits for a live shell slice:
// `{ name, data: { chunk, stream, toolCallId, truncated? } }`.
const slice = (
  toolCallId: string,
  chunk: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  truncated?: boolean
) => ({
  data: { chunk, stream, toolCallId, ...(truncated ? { truncated: true } : {}) },
  name: SHELL_OUTPUT_DATA_NAME,
  type: 'data',
});

describe('collectShellOutputs', () => {
  it('accumulates slices per tool call in emission order', () => {
    const result = collectShellOutputs([
      slice('call-1', 'first\n'),
      slice('call-1', 'second\n'),
      slice('call-2', 'other\n'),
      slice('call-1', 'third\n'),
    ]);
    expect(result['call-1']).toEqual({ text: 'first\nsecond\nthird\n', truncated: false });
    expect(result['call-2']).toEqual({ text: 'other\n', truncated: false });
  });

  it('interleaves stdout and stderr in the order they streamed', () => {
    const result = collectShellOutputs([
      slice('call-1', 'out-1\n', 'stdout'),
      slice('call-1', 'err-1\n', 'stderr'),
      slice('call-1', 'out-2\n', 'stdout'),
    ]);
    expect(result['call-1']?.text).toBe('out-1\nerr-1\nout-2\n');
  });

  it('marks a tool call truncated once a truncation notice arrives', () => {
    const result = collectShellOutputs([
      slice('call-1', 'lots\n'),
      slice('call-1', '\n[output truncated…]\n', 'stdout', true),
    ]);
    expect(result['call-1']?.truncated).toBe(true);
  });

  it('ignores non-shell-output parts and malformed slices', () => {
    const result = collectShellOutputs([
      { data: { kind: 'tool.started' }, name: 'brainstrike.run-event' },
      { data: { chunk: 123, toolCallId: 'call-1' }, name: SHELL_OUTPUT_DATA_NAME },
      { data: { chunk: 'ok\n' }, name: SHELL_OUTPUT_DATA_NAME },
      'not-an-object',
    ]);
    expect(result).toEqual({});
  });
});

// The streaming message appends parts per chunk and the panel re-derives shell
// output per update — the accumulator makes that O(new parts) instead of
// O(all parts), and keeps result identity stable when nothing shell-related
// changed (so context consumers don't re-render on unrelated text deltas).
describe('createShellOutputAccumulator', () => {
  const textDelta = (text: string) => ({ text, type: 'text' });

  it('matches collectShellOutputs across growing part prefixes', () => {
    const accumulate = createShellOutputAccumulator();
    const parts: unknown[] = [];
    const grow = (part: unknown) => {
      parts.push(part);
      const snapshot = [...parts];
      expect(accumulate('message', snapshot)).toEqual(collectShellOutputs(snapshot));
    };

    grow(textDelta('hello'));
    grow(slice('call-1', 'first\n'));
    grow(slice('call-1', 'second\n', 'stderr'));
    grow(slice('call-2', 'other\n'));
    grow(textDelta(' world'));
    grow(slice('call-1', '\n[output truncated…]\n', 'stdout', true));
  });

  it('returns the SAME record identity when new parts contain no shell slices', () => {
    const accumulate = createShellOutputAccumulator();
    // Parts are append-only: subsequent snapshots reuse earlier part objects.
    const shellPart = slice('call-1', 'out\n');
    const first = accumulate('message', [shellPart]);
    const second = accumulate('message', [shellPart, textDelta('answer')]);
    expect(second).toBe(first);
  });

  it('is not reset by a non-shell part REPLACED in place (the growing text part)', () => {
    const accumulate = createShellOutputAccumulator();
    const shellPart = slice('call-1', 'out\n');
    const first = accumulate('message', [textDelta('hel'), shellPart]);
    // The streaming text part is swapped for a new object with more text at
    // the same index on every chunk; already-scanned indexes are not re-read.
    const second = accumulate('message', [textDelta('hello'), shellPart, textDelta(' world')]);
    expect(second).toBe(first);
  });

  it('returns the same identity when called twice with the same array', () => {
    const accumulate = createShellOutputAccumulator();
    const parts = [slice('call-1', 'out\n')];
    expect(accumulate('message', parts)).toBe(accumulate('message', parts));
  });

  it('preserves untouched tool entries when another tool streams', () => {
    const accumulate = createShellOutputAccumulator();
    const call1Part = slice('call-1', 'a\n');
    const first = accumulate('message', [call1Part]);
    const second = accumulate('message', [call1Part, slice('call-2', 'b\n')]);
    expect(second).not.toBe(first);
    expect(second['call-1']).toBe(first['call-1']);
    expect(second['call-2']).toEqual({ text: 'b\n', truncated: false });
  });

  it('does not re-read already-processed parts on subsequent calls', () => {
    const reads = new Map<number, number>();
    const countingSlice = (index: number, toolCallId: string, chunk: string) => {
      const inner = slice(toolCallId, chunk);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'data') {
            reads.set(index, (reads.get(index) ?? 0) + 1);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    };

    const accumulate = createShellOutputAccumulator();
    const p0 = countingSlice(0, 'call-1', 'a\n');
    const p1 = countingSlice(1, 'call-1', 'b\n');
    accumulate('message', [p0]);
    const readsAfterFirst = reads.get(0) ?? 0;

    accumulate('message', [p0, p1]);
    expect(reads.get(0) ?? 0).toBe(readsAfterFirst);
    expect(reads.get(1) ?? 0).toBeGreaterThan(0);
  });

  it('recomputes from scratch when the parts array shrinks', () => {
    const accumulate = createShellOutputAccumulator();
    accumulate('message', [slice('call-1', 'a\n'), slice('call-1', 'b\n')]);
    const other = accumulate('message', [slice('call-9', 'z\n')]);
    expect(other).toEqual({ 'call-9': { text: 'z\n', truncated: false } });
  });

  it('recomputes from scratch for another message with as many parts', () => {
    const accumulate = createShellOutputAccumulator();
    accumulate('message-a', [slice('call-a', 'a\n')]);
    const other = accumulate('message-b', [slice('call-b', 'b\n')]);
    expect(other).toEqual({ 'call-b': { text: 'b\n', truncated: false } });
  });
});
