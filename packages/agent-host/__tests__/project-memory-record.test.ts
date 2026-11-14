/**
 * ADR-0040: a memory write is marked untrusted once its run, or an earlier run
 * on its branch, has read web or MCP tool output, and an Undo finds the write
 * its call made.
 */
import { describe, expect, it } from 'vitest';
import type { HostTool } from '../src/ports.ts';
import {
  committedMemoryChange,
  hostRunReadUntrustedContent,
} from '../src/project-memory-record.ts';
import type { HostEvent, HostLogRow } from '../src/protocol.ts';

const tool = (permissionToolId: string, risk: HostTool['risk'] = 'read'): HostTool =>
  ({
    description: permissionToolId,
    identity: permissionToolId,
    permissionToolId,
    risk,
  }) as HostTool;

const tools: Readonly<Record<string, HostTool>> = {
  brainstrike_readWorkspaceFile: tool('brainstrike.readWorkspaceFile'),
  brainstrike_webExtract: tool('brainstrike.webExtract'),
  docs_search: tool('docs_search', 'mcp'),
};

let seq = 0;
const row = (event: HostEvent): HostLogRow => ({
  event,
  seq: ++seq,
  threadId: 'thread-1',
  ts: 1_700_000_000_000 + seq,
});

/** A run the person started, after `parent` on its branch (null at the thread's start). */
function started(runId: string, parent: string | null): HostLogRow[] {
  const prompt = `prompt of ${runId}`;
  return [
    row({
      commandId: `command-${runId}`,
      method: 'run/start',
      payload: {
        modelId: 'openai::gpt-6-sol',
        parentMessageId: parent,
        prompt,
        threadId: 'thread-1',
      },
      result: { runId },
      type: 'command.accepted',
    }),
    row({
      modelId: 'openai::gpt-6-sol',
      parentMessageId: parent,
      prompt,
      runId,
      type: 'run.started',
    }),
  ];
}

/** One call of `toolId` in `runId` that returned its output. */
function call(toolId: string, toolCallId: string, runId: string): HostLogRow[] {
  return [
    row({ input: {}, runId, toolCallId, toolId, toolIdentity: toolId, type: 'effect.started' }),
    row({ output: 'read', runId, toolCallId, type: 'effect.finished' }),
  ];
}

describe('a run that has read untrusted content', () => {
  it('is untrusted after a web tool or an MCP tool returned, and not after a workspace read', () => {
    const run = (toolId: string) => [...started('run-1', null), ...call(toolId, 'c1', 'run-1')];
    expect(hostRunReadUntrustedContent(run('brainstrike_readWorkspaceFile'), 'run-1', tools)).toBe(
      false
    );
    expect(hostRunReadUntrustedContent(run('brainstrike_webExtract'), 'run-1', tools)).toBe(true);
    expect(hostRunReadUntrustedContent(run('docs_search'), 'run-1', tools)).toBe(true);
  });

  it('is untrusted when an earlier run on its branch read the web, and not on a sibling branch that never did', () => {
    // run-0, then run-1 read a page; run-2 follows run-1. run-3 is run-1's sibling, after run-0.
    const rows = [
      ...started('run-0', null),
      ...started('run-1', 'run-0'),
      ...call('brainstrike_webExtract', 'c1', 'run-1'),
      ...started('run-2', 'run-1'),
      ...started('run-3', 'run-0'),
    ];

    expect(hostRunReadUntrustedContent(rows, 'run-2', tools)).toBe(true);
    expect(hostRunReadUntrustedContent(rows, 'run-3', tools)).toBe(false);
  });

  it('does not count a call that has not returned', () => {
    const rows = [...started('run-1', null), ...call('brainstrike_webExtract', 'c1', 'run-1')];
    expect(hostRunReadUntrustedContent(rows.slice(0, -1), 'run-1', tools)).toBe(false);
  });

  it("is untrusted after the provider's own web search ran in a step of its branch", () => {
    const rows = [
      ...started('run-0', null),
      row({
        messages: [
          {
            content: [
              { providerExecuted: true, toolName: 'brainstrike_webSearch', type: 'tool-call' },
            ],
            role: 'assistant',
          },
        ],
        model: {},
        runId: 'run-0',
        stepNumber: 0,
        type: 'model.step',
        usage: {},
      }),
      ...started('run-1', 'run-0'),
    ];
    expect(hostRunReadUntrustedContent(rows, 'run-1', tools)).toBe(true);
  });
});

describe('the write an Undo names', () => {
  const change = {
    path: '/memories/a.md',
    previous: null,
    projectId: 'project-1',
    text: '# A\n',
    title: 'A',
    untrusted: false,
  };
  const saved = row({ ...change, runId: 'run-1', toolCallId: 'c1', type: 'memory.changed' });
  const target = { runId: 'run-1', threadId: 'thread-1', toolCallId: 'c1' };

  it('is the change its call committed', () => {
    expect(committedMemoryChange([saved], target)).toEqual(change);
  });

  it('is refused once undone, and for a call that saved nothing', () => {
    const undone = row({
      commandId: 'undo-1',
      runId: 'run-1',
      toolCallId: 'c1',
      type: 'memory.undone',
    });
    expect(() => committedMemoryChange([saved, undone], target)).toThrow(
      'This save was already undone.'
    );
    expect(() => committedMemoryChange([saved], { ...target, toolCallId: 'c2' })).toThrow(
      'This call saved nothing to memory.'
    );
  });
});
