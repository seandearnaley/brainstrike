import { access } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultRuntime } from '../src/fault-runtime';
import {
  createMcpLabFaultPlan,
  type McpLabFault,
  type McpLabFaultDeclaration,
} from '../src/faults';
import { type McpLabSession, startMcpLabScenario } from '../src/lab';
import { McpLabStdioChildFaults } from '../src/stdio-child-faults';
import { McpLabOwnedStdioTransport } from '../src/stdio-transport';
import { processIsGone } from './process-liveness';

function childFault(
  id: string,
  method: 'child/exit' | 'child/spawn' | 'child/stderr',
  fault: McpLabFault
): McpLabFaultDeclaration {
  return { fault, id, match: { method, occurrence: 1, phase: 'child-process' } };
}

function client(): Client {
  return new Client(
    { name: 'brainstrike-stdio-child-verifier', version: '1.0.0' },
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
    throw new AggregateError(failures, 'MCP stdio child verifier cleanup failed');
  }
}

function progress(token: string) {
  return {
    jsonrpc: '2.0' as const,
    method: 'notifications/progress' as const,
    params: { progress: 1, progressToken: token },
  };
}

function recordedStderrBytes(lab: McpLabSession): number {
  const message = lab.diagnostics()[0]?.message ?? '';
  const match = /^captured ([1-9][0-9]*) stderr bytes$/u.exec(message);
  return Number(match?.[1] ?? 0);
}

async function forceReapTransport(
  transport: McpLabOwnedStdioTransport,
  capturedPid: number | null = transport.lastSpawnedPid
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    transport.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 250);
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  const childPid = capturedPid ?? transport.lastSpawnedPid;
  if (childPid === null) {
    return;
  }
  if (!processIsGone(childPid)) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  }
  await expect.poll(() => processIsGone(childPid), { timeout: 2000 }).toBe(true);
}

describe('MCP stdio child fault verifier', () => {
  it('rejects concurrent starts and lets close cancel a delayed start before spawn', async () => {
    const plan = createMcpLabFaultPlan([
      childFault('close-during-spawn-delay', 'child/spawn', { delayMs: 30, kind: 'delay' }),
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const { transport } = lab.endpoint;
    const starting = transport.start();

    try {
      await expect(transport.start()).rejects.toThrow(/already started/i);
      const closing = transport.close();
      await expect(starting).rejects.toThrow('MCP lab stdio transport failed to start');
      await expect(closing).resolves.toBeUndefined();
      expect(transport.lastSpawnedPid).toBeNull();
      expect(transport.pid).toBeNull();
    } finally {
      await forceReapTransport(transport);
      await lab.close();
    }
  });

  it('flushes combined stderr before one post-handshake exit and reaps the child', async () => {
    const injectedText = 'combined stderr detail\n';
    const plan = createMcpLabFaultPlan([
      childFault('combined-stderr', 'child/stderr', {
        kind: 'child_stderr',
        text: injectedText,
      }),
      childFault('combined-exit', 'child/exit', {
        code: 8,
        kind: 'child_exit',
        signal: null,
      }),
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();
    const expectedBytes =
      Buffer.byteLength('mcp-lab-stdio-ready\n') +
      Buffer.byteLength('mcp-lab-stdio-ready-second-chunk\n') +
      Buffer.byteLength(injectedText);
    let childPid: number | null = null;

    try {
      await sdkClient.connect(lab.endpoint.transport);
      childPid = lab.endpoint.transport.lastSpawnedPid;
      await sdkClient.notification(progress('combined-exit')).catch(() => undefined);
      await expect(sdkClient.listTools()).rejects.toThrow();
      expect(plan.observations().map(({ faultId }) => faultId)).toEqual([
        'combined-stderr',
        'combined-exit',
      ]);
      await expect
        .poll(() => recordedStderrBytes(lab), { timeout: 2000 })
        .toBeGreaterThanOrEqual(expectedBytes);
      expect(JSON.stringify(lab.diagnostics())).not.toContain(injectedText.trim());
    } finally {
      await closeClientAndLab(sdkClient, lab);
    }
    if (childPid === null) {
      throw new Error('Expected a captured child pid');
    }
    await expect.poll(() => processIsGone(childPid), { timeout: 2000 }).toBe(true);
  });

  it('shares one exit trigger across concurrent post-handshake sends', async () => {
    const plan = createMcpLabFaultPlan([
      childFault('single-concurrent-exit', 'child/exit', {
        code: 6,
        kind: 'child_exit',
        signal: null,
      }),
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const sdkClient = client();

    try {
      await sdkClient.connect(lab.endpoint.transport);
      await Promise.allSettled([
        sdkClient.notification(progress('concurrent-exit-1')),
        sdkClient.notification(progress('concurrent-exit-2')),
      ]);
      await expect(sdkClient.listTools()).rejects.toThrow();
      expect(plan.observations().map(({ faultId }) => faultId)).toEqual(['single-concurrent-exit']);
    } finally {
      await closeClientAndLab(sdkClient, lab);
    }
  });

  it('leaves child faults untriggered when the stdio session closes unstarted', async () => {
    const plan = createMcpLabFaultPlan([
      childFault('unstarted-stderr', 'child/stderr', {
        kind: 'child_stderr',
        text: 'not emitted',
      }),
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });

    await expect(lab.close()).resolves.toMatchObject({
      stdioTransportsClosed: 0,
      untriggeredFaultIds: ['unstarted-stderr'],
    });
  });

  it('observes a close abort before a protocol delay defers the delegate send', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'deferred-send-close',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const transport = new McpLabOwnedStdioTransport(
      {
        args: ['-e', 'setInterval(() => {}, 1000)'],
        command: process.execPath,
        cwd: process.cwd(),
        env: {},
        era: 'modern',
      },
      () => undefined,
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'deferred-send-close')
    );
    await transport.start();
    const childPid = transport.lastSpawnedPid;
    try {
      const send = transport.send({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'close-race', version: '1' },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        },
      });
      const closing = transport.close();

      await expect(send).rejects.toThrow(/closed during send/i);
      await expect(closing).resolves.toBeUndefined();
      expect(plan.untriggeredIds()).toEqual(['deferred-send-close']);
    } finally {
      await forceReapTransport(transport, childPid);
    }
  });

  it('cancels a 10 MB backpressured send before joining it during close', async () => {
    const transport = new McpLabOwnedStdioTransport(
      {
        args: ['-e', 'setInterval(() => {}, 1000)'],
        command: process.execPath,
        cwd: process.cwd(),
        env: {},
        era: 'modern',
      },
      () => undefined,
      createMcpLabFaultRuntime(undefined, 'backpressure-close')
    );
    await transport.start();
    const childPid = transport.lastSpawnedPid;
    if (childPid === null) {
      await transport.close();
      throw new Error('Expected the blocked-send verifier to spawn a child');
    }
    try {
      const send = transport.send({
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { text: 'x'.repeat(10_000_000) }, name: 'echo' },
      });
      let sendSettled = false;
      void send
        .finally(() => {
          sendSettled = true;
        })
        .catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sendSettled).toBe(false);

      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      const closeTimedOut = new Promise<never>((_, reject) => {
        closeTimeout = setTimeout(
          () => reject(new Error('Backpressured transport close timed out')),
          3000
        );
      });
      try {
        await expect(Promise.race([transport.close(), closeTimedOut])).resolves.toBeUndefined();
      } finally {
        if (closeTimeout !== undefined) {
          clearTimeout(closeTimeout);
        }
      }
      await expect(send).rejects.toThrow(/closed during send/i);
      const postCloseSend = transport.send(progress('after-close'));
      expect(postCloseSend).toBeInstanceOf(Promise);
      await expect(postCloseSend).rejects.toThrow(/not started/i);
    } finally {
      await forceReapTransport(transport, childPid);
    }
  }, 10_000);

  it('does not poll child liveness when no child fault was configured', async () => {
    const childFaults = new McpLabStdioChildFaults(
      createMcpLabFaultRuntime(undefined, 'no-child-fault')
    );
    const isChildAlive = vi.fn(() => true);

    await expect(childFaults.close(123, isChildAlive)).resolves.toBeUndefined();
    expect(isChildAlive).not.toHaveBeenCalled();
  });

  it('never signals a child after the authoritative handle loses ownership', async () => {
    const plan = createMcpLabFaultPlan([
      childFault('lost-ownership-exit', 'child/exit', {
        code: null,
        kind: 'child_exit',
        signal: 'SIGTERM',
      }),
    ]);
    const childFaults = new McpLabStdioChildFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'lost-child-ownership')
    );
    const kill = vi.spyOn(process, 'kill');

    try {
      await expect(childFaults.afterSend(999_999, () => false, true)).rejects.toThrow(
        /no longer owned/i
      );
      expect(kill).not.toHaveBeenCalled();
      expect(plan.untriggeredIds()).toEqual(['lost-ownership-exit']);
    } finally {
      kill.mockRestore();
    }
  });

  it('retains the private control directory when exit proof times out', async () => {
    vi.useFakeTimers();
    const plan = createMcpLabFaultPlan([
      childFault('retained-control-stderr', 'child/stderr', {
        kind: 'child_stderr',
        text: 'retained',
      }),
    ]);
    const childFaults = new McpLabStdioChildFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'retained-control')
    );
    const args = await childFaults.args([]);
    const prefix = '--brainstrike-fault-control=';
    const configurationPath = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (!configurationPath) {
      throw new Error('Expected a private child fault configuration path');
    }

    try {
      const closing = childFaults.close(123, () => true);
      const rejected = expect(closing).rejects.toThrow('MCP lab stdio child cleanup failed');
      await vi.advanceTimersByTimeAsync(2500);
      await rejected;
      await expect(access(configurationPath)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await childFaults.close(123, () => false);
    }
  });
});
