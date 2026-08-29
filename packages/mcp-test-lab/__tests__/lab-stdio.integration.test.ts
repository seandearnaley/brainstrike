import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

describe('MCP lab stdio reference', () => {
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

    try {
      await client.connect(lab.endpoint.transport);
      childPid = lab.endpoint.transport.pid;
      expect(childPid).toEqual(expect.any(Number));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
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
      await client.close();
    }

    const firstReport = await lab.close();
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

  it('rejects HTTP execution for the stdio fixture before spawning', async () => {
    await expect(startMcpLabScenario('stdio-reference', { execution: 'loopback' })).rejects.toThrow(
      /stdio.*does not accept execution/i
    );
  });
});
