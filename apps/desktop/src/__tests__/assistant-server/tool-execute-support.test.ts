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
import { readToolCallId } from '../../assistant-server/tool-execute-support';

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
