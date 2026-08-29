import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultRuntime } from '../src/fault-runtime';
import {
  createMcpLabFaultPlan,
  type McpLabFault,
  type McpLabFaultDeclaration,
} from '../src/faults';
import { startMcpLabScenario } from '../src/lab';
import { McpLabOwnedStdioTransport } from '../src/stdio-transport';
import { processIsGone } from './process-liveness';

function client(): Client {
  return new Client(
    { name: 'brainstrike-stdio-child-fault-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
}

function childFault(
  id: string,
  method: 'child/exit' | 'child/spawn' | 'child/stderr',
  fault: McpLabFault
): McpLabFaultDeclaration {
  return { fault, id, match: { method, occurrence: 1, phase: 'child-process' } };
}

const spawnDelay = (id: string): McpLabFaultDeclaration =>
  childFault(id, 'child/spawn', { delayMs: 30, kind: 'delay' });
const stderrFault = (id: string, text: string): McpLabFaultDeclaration =>
  childFault(id, 'child/stderr', { kind: 'child_stderr', text });

describe('MCP stdio child fault execution', () => {
  it('delays spawn before starting a real child', async () => {
    const plan = createMcpLabFaultPlan([spawnDelay('stdio-spawn-delay')]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();
    const startedAt = performance.now();

    try {
      await sdkClient.connect(lab.endpoint.transport);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(30);
      expect(lab.endpoint.transport.pid).toEqual(expect.any(Number));
      expect(plan.observations()).toEqual([
        expect.objectContaining({ faultId: 'stdio-spawn-delay', method: 'child/spawn' }),
      ]);
    } finally {
      await sdkClient.close();
      await lab.close();
    }
  });

  it('emits real child stderr while retaining only an aggregate byte count', async () => {
    const injectedText = 'private injected child detail\n';
    const plan = createMcpLabFaultPlan([stderrFault('stdio-child-stderr', injectedText)]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();
    const expectedMinimumBytes =
      Buffer.byteLength('mcp-lab-stdio-ready\n') +
      Buffer.byteLength('mcp-lab-stdio-ready-second-chunk\n') +
      Buffer.byteLength(injectedText);

    try {
      await sdkClient.connect(lab.endpoint.transport);
      await expect
        .poll(() => plan.observations(), { timeout: 2000 })
        .toEqual([
          expect.objectContaining({ faultId: 'stdio-child-stderr', method: 'child/stderr' }),
        ]);
      await expect
        .poll(
          () => {
            const message = lab.diagnostics()[0]?.message ?? '';
            const match = /^captured ([1-9][0-9]*) stderr bytes$/u.exec(message);
            return Number(match?.[1] ?? 0);
          },
          { timeout: 2000 }
        )
        .toBeGreaterThanOrEqual(expectedMinimumBytes);
      expect(JSON.stringify(lab.diagnostics())).not.toContain(injectedText.trim());
      const childPid = lab.endpoint.transport.pid;
      if (process.platform === 'linux' && childPid !== null) {
        const argv = await readFile(`/proc/${childPid}/cmdline`, 'utf8');
        expect(argv).not.toContain(injectedText.trim());
      }
    } finally {
      await sdkClient.close();
      await lab.close();
    }
  });

  it.each([
    ['code', { code: 7, kind: 'child_exit', signal: null }],
    ['signal', { code: null, kind: 'child_exit', signal: 'SIGTERM' }],
  ] as const)(
    'terminates an established real child by %s after a post-handshake send',
    async (_kind, fault) => {
      const plan = createMcpLabFaultPlan([childFault('stdio-child-exit', 'child/exit', fault)]);
      const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
      if (lab.endpoint.kind !== 'stdio') {
        throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
      }
      const sdkClient = client();

      let childPid: number | null = null;
      try {
        await sdkClient.connect(lab.endpoint.transport);
        childPid = lab.endpoint.transport.lastSpawnedPid;
        expect(childPid).toEqual(expect.any(Number));
        await sdkClient
          .notification({
            method: 'notifications/progress',
            params: { progress: 1, progressToken: 'child-exit-trigger' },
          })
          .catch(() => undefined);
        await expect(sdkClient.listTools()).rejects.toThrow();
        expect(plan.observations()).toEqual([
          expect.objectContaining({ faultId: 'stdio-child-exit', method: 'child/exit' }),
        ]);
        if (childPid === null) {
          throw new Error('Expected a captured child pid');
        }
        const spawnedPid = childPid;
        await expect.poll(() => processIsGone(spawnedPid), { timeout: 2000 }).toBe(true);
      } finally {
        try {
          await sdkClient.close();
        } finally {
          await lab.close();
        }
      }
      if (childPid !== null) {
        await expect.poll(() => processIsGone(childPid), { timeout: 2000 }).toBe(true);
      }
    }
  );

  it('does not consume stderr or exit coordinates when spawn fails', async () => {
    const plan = createMcpLabFaultPlan([
      stderrFault('stderr-after-spawn', 'Bearer sk-never-written'),
      childFault('exit-after-spawn', 'child/exit', {
        code: 9,
        kind: 'child_exit',
        signal: null,
      }),
    ]);
    const runtime = createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'spawn-failure');
    const transport = new McpLabOwnedStdioTransport(
      {
        args: [],
        command: '/brainstrike/definitely-missing-node',
        cwd: process.cwd(),
        env: {},
        era: 'modern',
      },
      () => undefined,
      runtime
    );

    const failure = await transport.start().catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'MCP lab stdio transport failed to start' });
    expect(JSON.stringify(failure)).not.toContain('sk-never-written');
    expect(plan.untriggeredIds()).toEqual(['exit-after-spawn', 'stderr-after-spawn']);
    await transport.close();
  });
});
