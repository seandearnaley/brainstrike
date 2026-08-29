import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan, type McpLabFaultDeclaration } from '../src/faults';
import { type McpLabSession, startMcpLabScenario } from '../src/lab';

function client(): Client {
  return new Client(
    { name: 'brainstrike-stdio-protocol-fault-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
}

async function closeClientAndLab(sdkClient: Client, lab: McpLabSession): Promise<void> {
  const failures: unknown[] = [];
  try {
    await sdkClient.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await lab.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'MCP stdio protocol test cleanup failed');
  }
}

describe('MCP stdio protocol fault execution', () => {
  it('reaches every accepted modern stdio coordinate through the official client', async () => {
    const coordinates = [
      { method: 'server/discover', occurrence: 1, phase: 'initialization' },
      { method: 'tools/list', occurrence: 1, phase: 'operation' },
      { method: 'tools/call', occurrence: 1, phase: 'operation' },
      { method: 'subscriptions/listen', occurrence: 1, phase: 'subscription' },
      { method: 'notifications/cancelled', occurrence: 1, phase: 'subscription' },
      { method: 'notifications/progress', occurrence: 1, phase: 'subscription' },
    ] as const;
    const plan = createMcpLabFaultPlan(
      coordinates.map(
        (match, index): McpLabFaultDeclaration => ({
          fault: { delayMs: 1, kind: 'delay' },
          id: `stdio-coordinate-${index + 1}`,
          match,
        })
      )
    );
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();

    try {
      await sdkClient.connect(lab.endpoint.transport);
      await sdkClient.listTools();
      await sdkClient.callTool({ arguments: { text: 'stdio-protocol' }, name: 'echo' });
      await sdkClient.notification({
        method: 'notifications/progress',
        params: { progress: 1, progressToken: 'stdio-progress' },
      });
      const subscription = await sdkClient.listen({});
      await subscription.close();
      expect(plan.untriggeredIds()).toEqual([]);
      expect(plan.observations()).toHaveLength(coordinates.length);
    } finally {
      await closeClientAndLab(sdkClient, lab);
    }
  });

  it('times out one dropped tools response, emits cancellation, and recovers next request', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-first-tools-list',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'delay-timeout-cancellation',
        match: { method: 'notifications/cancelled', occurrence: 1, phase: 'subscription' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();

    try {
      await sdkClient.connect(lab.endpoint.transport);
      await expect(sdkClient.listTools(undefined, { timeout: 50 })).rejects.toThrow(/timed out/i);
      await expect
        .poll(() => plan.observations().map(({ faultId }) => faultId), {
          interval: 5,
          timeout: 1000,
        })
        .toEqual(['drop-first-tools-list', 'delay-timeout-cancellation']);
      await expect(sdkClient.listTools(undefined, { timeout: 1000 })).resolves.toMatchObject({
        tools: [expect.objectContaining({ name: 'echo' })],
      });
      expect(plan.untriggeredIds()).toEqual([]);
    } finally {
      await closeClientAndLab(sdkClient, lab);
    }
  });
});
