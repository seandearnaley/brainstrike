/**
 * ADR-0040: a memory write is marked untrusted once its run has read web or
 * MCP tool output, and an Undo finds the write its call made.
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
const row = (event: HostEvent): HostLogRow => ({ event, seq: ++seq, threadId: 'thread-1' });

function call(toolId: string, toolCallId: string, runId = 'run-1'): HostLogRow[] {
  return [
    row({
      input: {},
      runId,
      toolCallId,
      toolId,
      toolIdentity: toolId,
      type: 'effect.started',
    }),
    row({ output: 'read', runId, toolCallId, type: 'effect.finished' }),
  ];
}

describe('a run that has read untrusted content', () => {
  it('is untrusted after a web tool or an MCP tool returned, and not after a workspace read', () => {
    const run = { id: 'run-1' };
    expect(
      hostRunReadUntrustedContent(call('brainstrike_readWorkspaceFile', 'c1'), run, tools)
    ).toBe(false);
    expect(hostRunReadUntrustedContent(call('brainstrike_webExtract', 'c2'), run, tools)).toBe(
      true
    );
    expect(hostRunReadUntrustedContent(call('docs_search', 'c3'), run, tools)).toBe(true);
  });

  it('counts only its own run, and only a call that returned', () => {
    const run = { id: 'run-1' };
    expect(
      hostRunReadUntrustedContent(call('brainstrike_webExtract', 'c1', 'run-0'), run, tools)
    ).toBe(false);
    const started = call('brainstrike_webExtract', 'c2').slice(0, 1);
    expect(hostRunReadUntrustedContent(started, run, tools)).toBe(false);
  });

  it("is untrusted after the provider's own web search ran in one of its steps", () => {
    const rows = [
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
        runId: 'run-1',
        stepNumber: 0,
        type: 'model.step',
        usage: {},
      }),
    ];
    expect(
      hostRunReadUntrustedContent(
        rows,
        { id: 'run-1', nativeWebSearch: { toolId: 'brainstrike_webSearch' } },
        tools
      )
    ).toBe(true);
    expect(hostRunReadUntrustedContent(rows, { id: 'run-1' }, tools)).toBe(false);
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
