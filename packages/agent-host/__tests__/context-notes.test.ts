import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hostContextNotes } from '../src/context-notes.js';
import type { HostTool } from '../src/ports.js';
import { HostToolStates } from '../src/tool-state.js';

function tool(contextNote?: HostTool['contextNote']): HostTool {
  return {
    ...(contextNote ? { contextNote } : {}),
    description: 'fixture',
    execute: async () => undefined,
    identity: 'fixture',
    inputSchema: z.object({}),
    risk: 'read',
  } as HostTool;
}

describe('host context notes', () => {
  it("joins the admitted tools' notes over the thread's latest committed state", () => {
    const states = new HostToolStates();
    states.fold({
      event: {
        key: 'plan',
        runId: 'run-1',
        toolCallId: 'call-1',
        type: 'tool.state.updated',
        value: ['draft'],
      },
      seq: 1,
      threadId: 'thread-a',
    });
    states.fold({
      event: {
        key: 'plan',
        runId: 'run-1',
        toolCallId: 'call-2',
        type: 'tool.state.updated',
        value: ['final'],
      },
      seq: 2,
      threadId: 'thread-a',
    });
    const tools = {
      empty: tool(() => undefined),
      none: tool(),
      plan: tool((state) => `plan: ${JSON.stringify(state.read('plan'))}`),
      twice: tool(() => 'second note'),
    };
    expect(hostContextNotes(tools, states.view('thread-a'))).toBe('plan: ["final"]\n\nsecond note');
    expect(hostContextNotes(tools, states.view('thread-b'))).toBe('plan: undefined\n\nsecond note');
    expect(hostContextNotes({ none: tool() }, states.view('thread-a'))).toBeUndefined();
  });
});
