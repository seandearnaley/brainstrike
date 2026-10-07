/**
 * Pins for `readToolCallId`'s dual documented location (BST-1164 review,
 * finding: the plain-tool execute path journaled NULL `tool_call_id`).
 * Mastra hands a `createTool` instance the id under `agent.toolCallId`, and a
 * plain tool OBJECT (the desktop registry path) a TOP-LEVEL `toolCallId` —
 * both must resolve, mirroring `resolveShellOutputStreamer`'s existing dual
 * read in the same module. The end-to-end journal assertion lives in
 * `capture-on-edit.integration.test.ts`.
 */
import { createCanonicalToolContext } from '@brainstrike/agent-host';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseToolExecuteInput,
  readToolCallId,
  resolveShellOutputStreamer,
} from '../../assistant-server/tool-execute-support';

describe('resolveShellOutputStreamer', () => {
  it('writes a canonical ToolStream slice with its actual receiver', async () => {
    const emitted = Promise.withResolvers<{ chunk: unknown } | { error: unknown }>();
    const context = createCanonicalToolContext(
      {
        runId: 'run-shell-stream',
        signal: new AbortController().signal,
        threadId: 'thread-shell-stream',
        toolCallId: 'call-shell-stream',
        write: async (chunk) => {
          emitted.resolve({ chunk });
        },
      },
      'brainstrike.executeCommand'
    );
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

  it('keeps the plain outputWriter shape and tool-call identity', async () => {
    const emitted = Promise.withResolvers<unknown>();
    const stream = resolveShellOutputStreamer(
      { outputWriter: (chunk) => emitted.resolve(chunk), toolCallId: 'call-plain' },
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
        outputWriter: () => {
          throw failure;
        },
        toolCallId: 'call-failed-stream',
      },
      (error) => reported.resolve(error)
    );
    expect(() => stream?.({ chunk: 'shell output', stream: 'stdout' })).not.toThrow();
    expect(await reported.promise).toBe(failure);
  });
});

describe('parseToolExecuteInput', () => {
  const schema = z.strictObject({ id: z.string(), n: z.number() });

  it('returns the parsed value for valid input', () => {
    expect(parseToolExecuteInput(schema, { id: 'a', n: 1 })).toEqual({ id: 'a', n: 1 });
  });

  it('throws a compact SINGLE-LINE message on invalid input (token-efficient model feedback)', () => {
    // The raw ZodError message is a multi-line JSON blob; the model reads this
    // text verbatim on every failed call, so it must be one dense line.
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
    expect(caught.message).toContain('id:');
    expect(caught.message.length).toBeLessThan(400);
  });

  it('caps a pathological many-issue message instead of flooding the context', () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, z.string()])) as Record<
        string,
        z.ZodString
      >
    );
    let caught: Error | null = null;
    try {
      parseToolExecuteInput(wide, {} as never);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message.length ?? 0).toBeLessThanOrEqual(700);
  });
});

describe('readToolCallId', () => {
  it('resolves the agent-scoped location (createTool under an agent)', () => {
    expect(readToolCallId({ agent: { toolCallId: 'call-agent' } })).toBe('call-agent');
  });

  it('resolves the top-level location (plain tool object — the desktop registry path)', () => {
    expect(readToolCallId({ toolCallId: 'call-plain' })).toBe('call-plain');
  });

  it('prefers the agent-scoped id when both locations are present', () => {
    expect(readToolCallId({ agent: { toolCallId: 'call-agent' }, toolCallId: 'call-plain' })).toBe(
      'call-agent'
    );
  });

  it('is undefined with no context or no id in either location', () => {
    expect(readToolCallId(undefined)).toBeUndefined();
    expect(readToolCallId({})).toBeUndefined();
    expect(readToolCallId({ agent: {} })).toBeUndefined();
  });
});
