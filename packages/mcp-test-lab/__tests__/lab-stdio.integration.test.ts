import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { type McpLabSession, startMcpLabScenario } from '../src/lab';
import { processIsGone } from './process-liveness';
import { expectReferenceToolContract } from './reference-tool-contract';

const startUnchecked = startMcpLabScenario as unknown as (
  id: string,
  options: unknown
) => Promise<McpLabSession>;

describe('MCP lab stdio reference', () => {
  it('reports no stdio teardown when the fixture was never spawned', async () => {
    const lab = await startMcpLabScenario('stdio-reference', {});

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 0,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
  });

  it('owns one spawned child, captures only stderr byte counts, and proves teardown', async () => {
    const lab = await startMcpLabScenario('stdio-reference', {});
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    expect(lab.endpoint.command).toBe(process.execPath);
    expect(lab.endpoint.env).toEqual({});
    expect(lab.endpoint.args).toHaveLength(1);
    expect(lab.scenario.availability).toBe('executable');
    const client = new Client(
      { name: 'brainstrike-mcp-lab-stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    let childPid: number | null = null;
    let firstReport: Awaited<ReturnType<typeof lab.close>> | undefined;

    try {
      await client.connect(lab.endpoint.transport);
      childPid = lab.endpoint.transport.pid;
      expect(childPid).toEqual(expect.any(Number));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expectReferenceToolContract((await client.listTools()).tools, 'stdio');
      expect(
        await client.callTool({ arguments: { text: 'stdio-verified' }, name: 'echo' })
      ).toMatchObject({ structuredContent: { text: 'stdio-verified' } });
      await expect
        .poll(() => lab.diagnostics(), { timeout: 2000 })
        .toEqual([
          {
            correlationId: 'stdio-reference:child:1',
            kind: 'child-stderr',
            message: expect.stringMatching(/^captured [1-9][0-9]* stderr bytes$/u),
          },
        ]);
      expect(JSON.stringify(lab.diagnostics())).not.toContain('mcp-lab-stdio-ready');
    } finally {
      try {
        await client.close();
      } finally {
        firstReport = await lab.close();
      }
    }

    if (firstReport === undefined) {
      throw new Error('Expected stdio lab cleanup to produce a report');
    }
    expect(await lab.close()).toBe(firstReport);
    expect(firstReport).toEqual({
      httpListenersClosed: 0,
      stdioTransportsClosed: 1,
      untriggeredFaultIds: [],
    });
    expect(lab.endpoint.transport.pid).toBeNull();
    expect(lab.closed).toBe(true);
    if (childPid === null) {
      throw new Error('Expected the stdio fixture to expose a child pid');
    }
    await expect.poll(() => processIsGone(childPid), { timeout: 2000 }).toBe(true);
  });

  it('terminates the spawned child when the lab closes before its client', async () => {
    const lab = await startMcpLabScenario('stdio-reference', {});
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-owned-close-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    let childPid: number | null = null;

    try {
      await client.connect(lab.endpoint.transport);
      childPid = lab.endpoint.transport.pid;
      expect(childPid).toEqual(expect.any(Number));
      await expect(lab.close()).resolves.toMatchObject({ stdioTransportsClosed: 1 });
      if (childPid === null) {
        throw new Error('Expected the stdio fixture to expose a child pid');
      }
      const spawnedPid = childPid;
      await expect.poll(() => processIsGone(spawnedPid), { timeout: 2000 }).toBe(true);
    } finally {
      await lab.close();
      await client.close();
    }
  });

  it('treats inherited execution as missing instead of starting a listener', async () => {
    const options = Object.create({ execution: 'loopback' }) as Record<string, unknown>;
    const result = await startUnchecked('modern-reference', options).then(
      (lab) => ({ kind: 'session' as const, lab }),
      (error: unknown) => ({ error, kind: 'error' as const })
    );

    if (result.kind === 'session') {
      await result.lab.close();
      throw new Error('Expected inherited execution to be rejected');
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('requires explicit execution');
  });

  it('rejects HTTP execution for the stdio fixture before spawning', async () => {
    await expect(startUnchecked('stdio-reference', { execution: 'loopback' })).rejects.toThrow(
      /stdio.*does not accept execution/i
    );
  });

  it('rejects an explicitly present undefined execution key for stdio', async () => {
    await expect(startUnchecked('stdio-reference', { execution: undefined })).rejects.toThrow(
      /stdio.*does not accept execution/i
    );
  });

  it('preserves explicit execution presence when its getter deletes the property', async () => {
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, 'execution', {
      configurable: true,
      enumerable: true,
      get() {
        Reflect.deleteProperty(options, 'execution');
        return;
      },
    });

    await expect(startUnchecked('stdio-reference', options)).rejects.toThrow(
      /stdio.*does not accept execution/i
    );
  });
});
