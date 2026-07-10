import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { collectShellOutputs } from '../shell-output-parts';

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
