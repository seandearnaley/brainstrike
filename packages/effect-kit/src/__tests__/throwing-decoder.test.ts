import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeThrowingDecoder } from '../throwing-decoder.js';

const Row = Schema.Struct({
  history: Schema.Array(Schema.Finite).check(
    Schema.isMinLength(1, { message: 'MCP task history must contain 1-32 entries.' })
  ),
  task_id: Schema.String.annotate({ message: 'MCP task taskId must be text.' }),
}).annotate({ message: 'MCP task row must be an object.' });

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the decoder to throw');
}

describe('makeThrowingDecoder', () => {
  const decodeRow = makeThrowingDecoder(Row);

  it('returns the decoded value', () => {
    expect(decodeRow({ history: [1], task_id: 't-1' })).toEqual({ history: [1], task_id: 't-1' });
  });

  it('throws a TypeError carrying the custom message, the failing path, and the SchemaError', () => {
    const thrown = thrownBy(() => decodeRow({ history: [], task_id: 't-1' }));

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toBe(
      'MCP task history must contain 1-32 entries.\n  at ["history"]'
    );
    expect((thrown as TypeError).cause).toBeInstanceOf(Error);
  });

  it('reports only the first failing field, in declaration order', () => {
    const thrown = thrownBy(() => decodeRow({ history: [], task_id: 7 }));

    expect((thrown as TypeError).message).toMatch(/^MCP task history must contain/);
    expect((thrown as TypeError).message).not.toMatch(/taskId/);
  });

  it('uses the struct message for a value that is not an object', () => {
    expect(() => decodeRow('row')).toThrow(/^MCP task row must be an object\.$/);
  });
});
