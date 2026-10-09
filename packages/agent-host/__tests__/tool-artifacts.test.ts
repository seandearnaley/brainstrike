import { TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES } from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { TOOL_OUTPUT_ARTIFACT_RETENTION_MS } from '@brainstrike/assistant-contract/tool-output-artifact';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HostRunState } from '../src/core-state.js';
import type { HostTool } from '../src/ports.js';
import {
  hostArtifactId,
  hostArtifactReader,
  settleHostToolOutputs,
} from '../src/tool-artifacts.js';

const committedAt = Date.parse('2026-10-08T12:00:00.000Z');
const big = 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES + 1000);

function run(id: string, threadId: string, outputs: Record<string, string>): HostRunState {
  return {
    effectTools: new Map(Object.keys(outputs).map((call) => [call, 'brainstrike.big'])),
    id,
    outputCommittedAt: new Map(Object.keys(outputs).map((call) => [call, committedAt])),
    outputs: new Map(Object.entries(outputs)),
    threadId,
  } as unknown as HostRunState;
}

function tool(permissionToolId: string): HostTool {
  return {
    description: permissionToolId,
    execute: async () => undefined,
    identity: permissionToolId,
    inputSchema: z.object({}),
    permissionToolId,
    risk: 'read',
  } as unknown as HostTool;
}

describe('host tool output artifacts', () => {
  it('reads a settled committed output only from its own thread, until its retention ends', async () => {
    const runs = [run('run-1', 'thread-a', { 'call-1': big }), run('run-2', 'thread-b', {})];
    const id = hostArtifactId('run-1', 'call-1');
    const inThread = hostArtifactReader(
      () => runs,
      'thread-a',
      () => committedAt
    );
    expect(await inThread.readRange({ artifactId: id, limitBytes: 5, offsetByte: 2 })).toEqual({
      bytes: new TextEncoder().encode('xxxxx'),
      endByte: 7,
      offsetByte: 2,
      reference: {
        byteLength: big.length,
        expiresAt: new Date(committedAt + TOOL_OUTPUT_ARTIFACT_RETENTION_MS).toISOString(),
        format: 'text',
        id,
      },
      status: 'found',
    });
    const otherThread = hostArtifactReader(
      () => runs,
      'thread-b',
      () => committedAt
    );
    expect(await otherThread.readRange({ artifactId: id, limitBytes: 5, offsetByte: 0 })).toEqual({
      status: 'not_found',
    });
    const later = hostArtifactReader(
      () => runs,
      'thread-a',
      () => committedAt + TOOL_OUTPUT_ARTIFACT_RETENTION_MS
    );
    expect(await later.readRange({ artifactId: id, limitBytes: 5, offsetByte: 0 })).toMatchObject({
      status: 'expired',
    });
  });

  it('does not expose an inline-sized output as an artifact', async () => {
    const runs = [run('run-1', 'thread-a', { 'call-1': 'small' })];
    const reader = hostArtifactReader(
      () => runs,
      'thread-a',
      () => committedAt
    );
    expect(
      await reader.readRange({
        artifactId: hostArtifactId('run-1', 'call-1'),
        limitBytes: 5,
        offsetByte: 0,
      })
    ).toEqual({ status: 'not_found' });
  });

  it('settles an oversized output as its first artifact page only when the run can page it', async () => {
    const owner = run('run-1', 'thread-a', { 'call-1': big });
    const withoutReader = settleHostToolOutputs(owner, { big: tool('brainstrike.big') });
    expect(withoutReader['big']?.toModelOutput).toBeUndefined();

    const settled = settleHostToolOutputs(owner, {
      big: tool('brainstrike.big'),
      reader: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
    });
    const output = await settled['big']?.toModelOutput?.({
      input: {},
      output: big,
      toolCallId: 'call-1',
    });
    expect(output).toMatchObject({
      type: 'json',
      value: {
        endByte: expect.any(Number),
        format: 'text',
        next: { input: { cursor: expect.stringMatching(/^bsto1\./u) }, tool: 'reader' },
        offsetByte: 0,
      },
    });
  });
});
