/** The producer consumes one host execution identity and structural writer. */
import { createCanonicalToolContext } from '@brainstrike/agent-host';
import { effectToolInputSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import {
  parseToolExecuteInput,
  readToolCallId,
  resolveShellOutputStreamer,
} from '@brainstrike/host-capabilities/native-tools';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

describe('resolveShellOutputStreamer', () => {
  it('writes a canonical host slice with its actual receiver', async () => {
    const emitted = Promise.withResolvers<{ chunk: unknown } | { error: unknown }>();
    const context = createCanonicalToolContext({
      runId: 'run-shell-stream',
      signal: new AbortController().signal,
      threadId: 'thread-shell-stream',
      toolCallId: 'call-shell-stream',
      write: async (chunk) => {
        emitted.resolve({ chunk });
      },
    });
    const stream = resolveShellOutputStreamer(context, (error) => emitted.resolve({ error }));
    expect(stream).toBeDefined();
    stream?.({ chunk: 'ordinary shell output\n', stream: 'stdout' });
    expect(await emitted.promise).toEqual({
      chunk: {
        chunk: 'ordinary shell output\n',
        stream: 'stdout',
        toolCallId: 'call-shell-stream',
        type: 'brainstrike.shell-output.chunk',
      },
    });
  });

  it('keeps the structural writer and tool-call identity', async () => {
    const emitted = Promise.withResolvers<unknown>();
    const stream = resolveShellOutputStreamer(
      {
        toolCallId: 'call-plain',
        writer: {
          custom: async (chunk) => {
            emitted.resolve(chunk);
          },
        },
      },
      (error) => emitted.reject(error)
    );
    expect(stream).toBeDefined();
    stream?.({ chunk: 'plain stderr\n', stream: 'stderr', truncated: true });
    expect(await emitted.promise).toEqual({
      chunk: 'plain stderr\n',
      stream: 'stderr',
      toolCallId: 'call-plain',
      truncated: true,
      type: 'brainstrike.shell-output.chunk',
    });
  });

  it('reports a synchronous writer failure through the streaming error callback', async () => {
    const reported = Promise.withResolvers<unknown>();
    const failure = new Error('Synthetic stream writer failure');
    const stream = resolveShellOutputStreamer(
      {
        toolCallId: 'call-failed-stream',
        writer: {
          custom: async () => {
            throw failure;
          },
        },
      },
      (error) => reported.resolve(error)
    );
    expect(() => stream?.({ chunk: 'shell output', stream: 'stdout' })).not.toThrow();
    expect(await reported.promise).toBe(failure);
  });
});

// Native tool inputs accept only Effect-authored schemas since the tool Zod
// bridge was retired (BST-2045); the producer closes the object, so `extra`
// below is refused as well (BST-2056).
describe('parseToolExecuteInput', () => {
  const schema = effectToolInputSchema(Schema.Struct({ id: Schema.String, n: Schema.Number }));

  it('returns the parsed value for valid input', () => {
    expect(parseToolExecuteInput(schema, { id: 'a', n: 1 })).toEqual({ id: 'a', n: 1 });
  });

  it('refuses obsolete wrapped inputs instead of reinterpreting model data', () => {
    expect(() => parseToolExecuteInput(schema, { context: { id: 'a', n: 1 } } as never)).toThrow(
      'invalid tool input'
    );
  });

  it('throws a compact SINGLE-LINE message on invalid input (token-efficient model feedback)', () => {
    // A raw decode error is a multi-line blob; the model reads this text
    // verbatim on every failed call, so it must be one dense line.
    let caught: Error | null = null;
    try {
      parseToolExecuteInput(schema, { extra: true, id: 5 } as never);
    } catch (error) {
      caught = error as Error;
    }
    if (!caught) {
      throw new Error('expected parseToolExecuteInput to throw');
    }
    expect(caught.message).not.toContain('\n');
    expect(caught.message).toContain('extra:');
    expect(caught.message).toContain('id:');
    expect(caught.message.length).toBeLessThan(400);
  });

  it('caps a pathological many-issue message instead of flooding the context', () => {
    const wide = effectToolInputSchema(
      Schema.Struct(
        Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, Schema.String]))
      )
    );
    let caught: Error | null = null;
    try {
      parseToolExecuteInput(wide, {} as never);
    } catch (error) {
      caught = error as Error;
    }
    // Pin the truncated issue list itself: a schema the producer refuses throws
    // a short TypeError that would also pass the length check.
    expect(caught?.message).toMatch(/^invalid tool input — field0: .+…$/);
    expect(caught?.message.length ?? 0).toBeLessThanOrEqual(700);
  });
});

describe('readToolCallId', () => {
  it('reads only the host-owned location', () => {
    expect(readToolCallId({ toolCallId: 'call-host' })).toBe('call-host');
    expect(readToolCallId({ agent: { toolCallId: 'untrusted' } } as never)).toBeUndefined();
    expect(readToolCallId(undefined)).toBeUndefined();
    expect(readToolCallId({})).toBeUndefined();
  });
});
