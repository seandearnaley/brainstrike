import {
  applyToolModelOutputProjections,
  resolveScaledToolResultBudget,
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
} from '@brainstrike/agent/tool-runtime';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { TOOL_OUTPUT_ARTIFACT_RETENTION_MS } from '@brainstrike/assistant-contract/tool-output-artifact';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HostRunState } from '../src/core-state.js';
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
    resolvedToolResultBudget: ANCHOR_BUDGET,
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

/** The generic bounded projection the host installs for a tool with none of its own. */
function projectedModelOutput(
  catalogId: string,
  output: string
): NonNullable<HostTool['toModelOutput']> {
  const projected = applyToolModelOutputProjections(
    {
      [catalogId]: {
        description: 'fixture',
        execute: async () => output,
        id: catalogId,
        inputSchema: { jsonSchema: { additionalProperties: false, type: 'object' } },
      },
    } as never,
    new Map([[catalogId, catalogId]]),
    undefined,
    ANCHOR_BUDGET
  );
  const project = (projected[catalogId] as { toModelOutput: (value: unknown) => unknown })
    .toModelOutput;
  return (async ({ output: value }) => await project(value)) as NonNullable<
    HostTool['toModelOutput']
  >;
}

/** An MCP binding as `bindMcpTool` shapes it: `mcpAuthority` present, generic projection. */
function mcpTool(catalogId: string, output: string): HostTool {
  return {
    ...tool(catalogId),
    mcpAuthority: { configuredServerId: 'server', generation: 1 },
    risk: 'mcp',
    toModelOutput: projectedModelOutput(catalogId, output),
  } as unknown as HostTool;
}

/** A native tool whose own projection truncates with its documented recovery. */
function nativeProjectedTool(catalogId: string, output: string): HostTool {
  return {
    ...tool(catalogId),
    toModelOutput: projectedModelOutput(catalogId, output),
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

  it('refuses a catalog that registers two eligible artifact readers', () => {
    expect(() =>
      requireSoleHostArtifactReader({
        first: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
        second: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
      })
    ).toThrow(/one eligible artifact reader/u);
  });

  it('settles an MCP result the model projection would clip, so the model can page the rest', async () => {
    // Below the inline ceiling, so size alone keeps it inline; the run's own
    // projection budget is what it exceeds.
    const clipped = 'x'.repeat(9042);
    expect(new TextEncoder().encode(clipped).byteLength).toBeLessThan(
      TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES
    );
    const owner = run('run-1', 'thread-a', { 'call-1': clipped }, 'server.fetch');
    const settled = settleHostToolOutputs(owner, {
      fetch: mcpTool('server.fetch', clipped),
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

    // Settlement and reads must agree, or the cursor it just handed the model
    // resolves to not_found.
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
    ).toMatchObject({ status: 'found' });
  });

  it('leaves a non-MCP result that its own projection clips to that projection', async () => {
    const clipped = 'y'.repeat(9042);
    const owner = run('run-1', 'thread-a', { 'call-1': clipped }, 'brainstrike.workspaceSearch');
    const settled = settleHostToolOutputs(owner, {
      reader: tool(NATIVE_TOOL_ID.readToolOutputArtifact),
      search: nativeProjectedTool('brainstrike.workspaceSearch', clipped),
    });
    const output = await settled['search']?.toModelOutput?.({
      input: {},
      output: clipped,
      toolCallId: 'call-1',
    });
    expect(JSON.stringify(output)).not.toContain('bsto1.');
  });
});
