import { TOOL_APPROVAL_ANSWERED_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it } from 'vitest';
import { DataStreamCode } from '../stream/data-stream-codes';
import { DataStreamMapper } from '../stream/data-stream-mapper';
import type { StreamChunk } from '../types';

// A parked sibling approval the host answered under a session grant reaches
// the renderer as a plain aui-data part keyed like the notice it answers, so
// the card locks live and after reload (BST-1723, 2026-09-14).
describe('tool-approval-answered mapping', () => {
  it('encodes the answered approval as its own data part', () => {
    const mapper = new DataStreamMapper('assistant-message');
    const chunk: StreamChunk = {
      decision: 'approve',
      delegation: {
        path: [
          {
            childRuntimeRunId: 'child-run',
            parentRuntimeRunId: 'root-run',
            parentToolCallId: 'background-child-2',
            personaId: 'explore',
          },
        ],
        toolCallId: 'background-read-2',
      },
      reason: 'session-grant',
      runId: 'root-run',
      toolCallId: 'background-child-2',
      toolName: 'brainstrike.grepSearch',
      type: 'tool-approval-answered',
    };
    const encoded = [...mapper.handleChunk(chunk)];
    expect(encoded).toEqual([
      {
        code: DataStreamCode.auiDataPart,
        value: {
          data: {
            decision: 'approve',
            delegation: chunk.delegation,
            reason: 'session-grant',
            runId: 'root-run',
            toolCallId: 'background-child-2',
            toolName: 'brainstrike.grepSearch',
          },
          name: TOOL_APPROVAL_ANSWERED_DATA_NAME,
        },
      },
    ]);
  });
});
