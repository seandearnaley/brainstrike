import {
  resolveScaledToolResultBudget,
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
} from '@brainstrike/agent/tool-runtime';
import {
  NATIVE_TOOL_ID,
  NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS,
} from '@brainstrike/assistant-contract';
import { TOOL_OUTPUT_ARTIFACT_RETENTION_MS } from '@brainstrike/assistant-contract/tool-output-artifact';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { projectionClipsOutput } from '../src/core-run-execution.js';
import { foldHostRunEffect, type HostRunState } from '../src/core-state.js';
import type { HostTool } from '../src/ports.js';
import {
  hostArtifactId,
  hostArtifactReader,
  requireSoleHostArtifactReader,
  settleHostToolOutputs,
} from '../src/tool-artifacts.js';

const committedAt = Date.parse('2026-10-08T12:00:00.000Z');
const big = 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES + 1000);
const ANCHOR_BUDGET = resolveScaledToolResultBudget(131_072);
/** Under the inline ceiling, over the run's projection budget. */
const clipped = 'x'.repeat(9042);

function run(
  id: string,
  threadId: string,
  outputs: Record<string, string>,
  toolName = 'brainstrike.big'
): HostRunState {
  return {
    artifactSettled: new Set<string>(),
    effectTools: new Map(Object.keys(outputs).map((call) => [call, toolName])),
    id,
    outputCommittedAt: new Map(Object.keys(outputs).map((call) => [call, committedAt])),
    outputs: new Map(Object.entries(outputs)),
    started: new Set<string>(),
    threadId,
  } as unknown as HostRunState;
}

/** A run as a replay rebuilds it: nothing but its committed effect events. */
function replayed(id: string, threadId: string, event: Record<string, unknown>): HostRunState {
  const state = run(id, threadId, {}, 'server.fetch');
  foldHostRunEffect(
    new Map([[id, state]]),
    { runId: id, toolCallId: 'call-1', toolId: 'server.fetch', type: 'effect.started' } as never,
    committedAt
  );
  foldHostRunEffect(new Map([[id, state]]), event as never, committedAt);
  return state;
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

  it.each([...NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS, 'skill'])(
    'never settles a committed %s output as a durable artifact',
    async (toolName) => {
      const owner = run('run-1', 'thread-a', { 'call-1': big }, toolName);

      const settled = settleHostToolOutputs(owner, {
        reader: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
        sensitive: tool(toolName),
      });
      const output = await settled['sensitive']?.toModelOutput?.({
        input: {},
        output: big,
        toolCallId: 'call-1',
      });

      // Bounded by the ordinary projection, never handed a durable cursor.
      expect(JSON.stringify(output)).not.toContain('bsto1.');
      // And the committed output is not reachable as an artifact at all.
      const reader = hostArtifactReader(
        () => [owner],
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
    }
  );

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

  it('refuses a catalog that registers two eligible artifact readers', () => {
    expect(() =>
      requireSoleHostArtifactReader({
        first: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
        second: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
      })
    ).toThrow(/one eligible artifact reader/u);
  });

  it('commits the clipped decision for an MCP result the projection would shrink', () => {
    const admission = { resolvedToolResultBudget: ANCHOR_BUDGET } as never;
    const action = { toolCatalogId: 'server.fetch', toolId: 'fetch' } as never;
    expect(projectionClipsOutput(admission, { risk: 'mcp' } as never, action, clipped)).toBe(true);
    // Its own projector keeps a native tool's documented recovery instead.
    expect(projectionClipsOutput(admission, { risk: 'read' } as never, action, clipped)).toBe(
      false
    );
    // A result the projection carries whole needs no artifact.
    expect(projectionClipsOutput(admission, { risk: 'mcp' } as never, action, 'small')).toBe(false);
  });

  it('clips nothing on a run whose tools are projected unbounded', () => {
    // No resolved budget means no bounded projection (it reaches tools only
    // through createAgentHostToolBindings), so nothing is clipped and there is
    // nothing to recover — the capability is absent, not failing.
    expect(
      projectionClipsOutput(
        {} as never,
        { risk: 'mcp' } as never,
        { toolCatalogId: 'server.fetch' } as never,
        clipped
      )
    ).toBe(false);
  });

  it('settles a committed clipped output as its first artifact page', async () => {
    const owner = run('run-1', 'thread-a', { 'call-1': clipped }, 'server.fetch');
    owner.artifactSettled.add('call-1');
    const settled = settleHostToolOutputs(owner, {
      fetch: tool('server.fetch'),
      reader: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
    });
    const output = await settled['fetch']?.toModelOutput?.({
      input: {},
      output: clipped,
      toolCallId: 'call-1',
    });
    expect(JSON.stringify(output)).not.toContain('tool_result_truncated');
    expect(output).toMatchObject({
      type: 'json',
      value: { next: { input: { cursor: expect.stringMatching(/^bsto1\./u) }, tool: 'reader' } },
    });
  });

  it('a replayed run reads a clipped artifact the live run handed a cursor for', async () => {
    // The defect this pins: `outputs` is refolded from committed events, so a
    // decision kept only in live state left the cursor resolving to not_found.
    const restored = replayed('run-1', 'thread-a', {
      output: clipped,
      projectionClipped: true,
      runId: 'run-1',
      toolCallId: 'call-1',
      type: 'effect.finished',
    });
    expect(restored.artifactSettled.has('call-1')).toBe(true);
    const reader = hostArtifactReader(
      () => [restored],
      'thread-a',
      () => committedAt
    );
    expect(
      await reader.readRange({
        artifactId: hostArtifactId('run-1', 'call-1'),
        limitBytes: 4,
        offsetByte: 0,
      })
    ).toMatchObject({ reference: { byteLength: clipped.length }, status: 'found' });
  });

  it('a replayed run exposes no artifact for a committed output that was never clipped', async () => {
    const restored = replayed('run-1', 'thread-a', {
      output: clipped,
      runId: 'run-1',
      toolCallId: 'call-1',
      type: 'effect.finished',
    });
    expect(restored.artifactSettled.has('call-1')).toBe(false);
    const reader = hostArtifactReader(
      () => [restored],
      'thread-a',
      () => committedAt
    );
    expect(
      await reader.readRange({
        artifactId: hostArtifactId('run-1', 'call-1'),
        limitBytes: 4,
        offsetByte: 0,
      })
    ).toEqual({ status: 'not_found' });
  });
});
