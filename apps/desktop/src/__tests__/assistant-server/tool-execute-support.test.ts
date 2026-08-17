/**
 * Pins for `readToolCallId`'s dual documented location (BST-1164 review,
 * finding: the plain-tool execute path journaled NULL `tool_call_id`).
 * Mastra hands a `createTool` instance the id under `agent.toolCallId`, and a
 * plain tool OBJECT (the desktop registry path) a TOP-LEVEL `toolCallId` —
 * both must resolve, mirroring `resolveShellOutputStreamer`'s existing dual
 * read in the same module. The end-to-end journal assertion lives in
 * `capture-on-edit.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseToolExecuteInput, readToolCallId } from '../../assistant-server/tool-execute-support';

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
