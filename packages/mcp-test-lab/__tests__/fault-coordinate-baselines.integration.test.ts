import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan, type McpLabFaultDeclaration } from '../src/faults';
import { type McpLabCleanupReport, startMcpLabScenario } from '../src/lab';

function delayFaults(
  coordinates: readonly Omit<McpLabFaultDeclaration, 'fault' | 'id'>[]
): readonly McpLabFaultDeclaration[] {
  return coordinates.map(({ match }) => ({
    fault: { delayMs: 1, kind: 'delay' },
    id: `${match.method.replaceAll(/[^a-z0-9]+/gu, '-')}-${match.occurrence}`,
    match,
  }));
}

async function connectClient(
  scenarioId: 'legacy-reference' | 'modern-reference',
  declarations: readonly McpLabFaultDeclaration[]
): Promise<{
  readonly client: Client;
  readonly close: () => Promise<McpLabCleanupReport>;
  readonly plan: ReturnType<typeof createMcpLabFaultPlan>;
}> {
  const plan = createMcpLabFaultPlan(declarations);
  const lab = await startMcpLabScenario(scenarioId, {
    execution: 'in-process',
    faultPlan: plan,
  });
  if (lab.endpoint.kind !== 'in-process-http') {
    throw new Error(`Expected in-process endpoint, received ${lab.endpoint.kind}`);
  }
  const client = new Client(
    { name: 'brainstrike-coordinate-baseline', version: '1' },
    {
      capabilities: { roots: { listChanged: true } },
      versionNegotiation:
        scenarioId === 'modern-reference' ? { mode: { pin: '2026-07-28' } } : { mode: 'legacy' },
    }
  );
  await client.connect(
    new StreamableHTTPClientTransport(lab.endpoint.url, { fetch: lab.endpoint.fetch })
  );
  return {
    client,
    async close() {
      await client.close();
      return lab.close();
    },
    plan,
  };
}

describe('MCP HTTP executable coordinate baselines', () => {
  it('reaches every modern coordinate through the official SDK client', async () => {
    const session = await connectClient(
      'modern-reference',
      delayFaults([
        { match: { method: 'server/discover', occurrence: 1, phase: 'initialization' } },
        { match: { method: 'completion/complete', occurrence: 1, phase: 'operation' } },
        { match: { method: 'prompts/get', occurrence: 1, phase: 'operation' } },
        { match: { method: 'prompts/list', occurrence: 1, phase: 'operation' } },
        { match: { method: 'resources/list', occurrence: 1, phase: 'operation' } },
        { match: { method: 'resources/read', occurrence: 1, phase: 'operation' } },
        { match: { method: 'tools/list', occurrence: 1, phase: 'operation' } },
        { match: { method: 'tools/call', occurrence: 1, phase: 'operation' } },
        { match: { method: 'subscriptions/listen', occurrence: 1, phase: 'subscription' } },
        {
          match: { method: 'notifications/cancelled', occurrence: 1, phase: 'subscription' },
        },
        { match: { method: 'notifications/progress', occurrence: 1, phase: 'subscription' } },
      ])
    );
    let report: McpLabCleanupReport;
    try {
      await session.client.complete({
        argument: { name: 'unused', value: '' },
        ref: { name: 'test_simple_prompt', type: 'ref/prompt' },
      });
      await session.client.listPrompts();
      await session.client.getPrompt({ name: 'test_simple_prompt' });
      await session.client.listResources();
      await session.client.readResource({ uri: 'test://static-text' });
      await session.client.listTools();
      await session.client.callTool({ name: 'test_simple_text' });
      await session.client.notification({
        method: 'notifications/progress',
        params: { progress: 1, progressToken: 'modern-progress' },
      });
      const subscription = await session.client.listen({});
      await subscription.close();
    } finally {
      report = await session.close();
    }
    expect(report.untriggeredFaultIds).toEqual([]);
    expect(session.plan.observations()).toHaveLength(11);
  });

  it('reaches every legacy coordinate through the official SDK client', async () => {
    const session = await connectClient(
      'legacy-reference',
      delayFaults([
        { match: { method: 'initialize', occurrence: 1, phase: 'initialization' } },
        {
          match: {
            method: 'notifications/initialized',
            occurrence: 1,
            phase: 'initialization',
          },
        },
        { match: { method: 'ping', occurrence: 1, phase: 'initialization' } },
        { match: { method: 'tools/list', occurrence: 1, phase: 'operation' } },
        { match: { method: 'tools/call', occurrence: 1, phase: 'operation' } },
        {
          match: { method: 'notifications/cancelled', occurrence: 1, phase: 'subscription' },
        },
        { match: { method: 'notifications/progress', occurrence: 1, phase: 'subscription' } },
        {
          match: {
            method: 'notifications/roots/list_changed',
            occurrence: 1,
            phase: 'subscription',
          },
        },
      ])
    );
    let report: McpLabCleanupReport;
    try {
      await session.client.ping();
      await session.client.listTools();
      await session.client.callTool({ arguments: { text: 'legacy' }, name: 'echo' });
      await session.client.notification({
        method: 'notifications/progress',
        params: { progress: 1, progressToken: 'legacy-progress' },
      });
      await session.client.notification({
        method: 'notifications/cancelled',
        params: { reason: 'baseline', requestId: 'legacy-request' },
      });
      await session.client.notification({ method: 'notifications/roots/list_changed' });
    } finally {
      report = await session.close();
    }
    expect(report.untriggeredFaultIds).toEqual([]);
    expect(session.plan.observations()).toHaveLength(8);
  });
});
