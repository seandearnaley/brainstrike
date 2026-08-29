import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, vi } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab fault and cleanup lifecycle', () => {
  it('injects configured transport faults into a real exchange and records handler diagnostics', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-first-request',
        match: { method: 'http/request', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await expect(fetch(lab.endpoint.url, { method: 'POST' })).rejects.toThrow();
    expect(lab.diagnostics()).toEqual([
      expect.objectContaining({
        correlationId: 'modern-reference:exchange:1',
        kind: 'handler-error',
        message: expect.stringContaining('drop-first-request'),
      }),
    ]);
    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
  });

  it('reports untriggered faults from the attached plan instead of hardcoding cleanup evidence', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'unused-tool-fault',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: ['unused-tool-fault'],
    });
  });

  it('does not clone POST bodies for a fault plan that cannot target protocol coordinates', async () => {
    const baselineLab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const shutdownPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'delay-close-only',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
    ]);
    const shutdownLab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: shutdownPlan,
    });
    if (baselineLab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${baselineLab.endpoint.kind}`);
    }
    if (shutdownLab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${shutdownLab.endpoint.kind}`);
    }
    const requestInit = {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    } as const;

    const clone = vi.spyOn(Request.prototype, 'clone');
    try {
      const baselineResponse = await baselineLab.endpoint.fetch(
        baselineLab.endpoint.url,
        requestInit
      );
      await baselineResponse.arrayBuffer();
      const baselineCount = clone.mock.calls.length;
      clone.mockClear();

      const shutdownResponse = await shutdownLab.endpoint.fetch(
        shutdownLab.endpoint.url,
        requestInit
      );
      await shutdownResponse.arrayBuffer();
      expect(clone).toHaveBeenCalledTimes(baselineCount);
    } finally {
      clone.mockRestore();
      await baselineLab.close();
      await shutdownLab.close();
    }

    expect(shutdownPlan.untriggeredIds()).toEqual([]);
  });

  it('clones only while a remaining MCP body fault can match the request', async () => {
    const pingPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'fail-first-ping',
        match: { method: 'ping', occurrence: 1, phase: 'initialization' },
      },
    ]);
    const authorizationPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'token-only',
        match: { method: 'oauth/token', occurrence: 1, phase: 'authorization' },
      },
    ]);
    const baselineLab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    const pingLab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: pingPlan,
    });
    const authorizationLab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: authorizationPlan,
    });
    for (const lab of [baselineLab, pingLab, authorizationLab]) {
      if (lab.endpoint.kind !== 'in-process-http') {
        throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
      }
    }
    if (
      baselineLab.endpoint.kind !== 'in-process-http' ||
      pingLab.endpoint.kind !== 'in-process-http' ||
      authorizationLab.endpoint.kind !== 'in-process-http'
    ) {
      throw new Error('MCP lab endpoint narrowing failed');
    }
    const requestInit = {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    } as const;
    const clone = vi.spyOn(Request.prototype, 'clone');

    try {
      await (await baselineLab.endpoint.fetch(baselineLab.endpoint.url, requestInit)).arrayBuffer();
      const baselineCount = clone.mock.calls.length;
      clone.mockClear();

      expect((await pingLab.endpoint.fetch(pingLab.endpoint.url, requestInit)).status).toBe(418);
      expect(pingPlan.untriggeredIds()).toEqual([]);
      clone.mockClear();

      await (await pingLab.endpoint.fetch(pingLab.endpoint.url, requestInit)).arrayBuffer();
      expect(clone).toHaveBeenCalledTimes(baselineCount);
      clone.mockClear();

      await (
        await authorizationLab.endpoint.fetch(authorizationLab.endpoint.url, requestInit)
      ).arrayBuffer();
      expect(clone).toHaveBeenCalledTimes(baselineCount);
    } finally {
      clone.mockRestore();
      await baselineLab.close();
      await pingLab.close();
      await authorizationLab.close();
    }

    expect(pingPlan.untriggeredIds()).toEqual([]);
    expect(authorizationPlan.untriggeredIds()).toEqual(['token-only']);
  });

  it('does not let an HTTP body consume the dedicated shutdown coordinate', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'unused-operation',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { kind: 'cleanup_error' },
        id: 'close-only',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan,
    });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await lab.endpoint.fetch(
      new Request(lab.endpoint.url, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'transport/close' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    );
    expect(faultPlan.untriggeredIds()).toContain('close-only');
    await expect(lab.close()).rejects.toThrow('close-only');
    await expect(lab.close()).resolves.toMatchObject({
      untriggeredFaultIds: ['unused-operation'],
    });
  });

  it('does not consume a child-exit fault until the lab-owned stdio transport starts', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { code: 7, kind: 'child_exit', signal: null },
        id: 'exit-after-spawn',
        match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 0,
      stdioTransportsClosed: 1,
      untriggeredFaultIds: ['exit-after-spawn'],
    });
  });

  it('injects a real child exit and reports the failed stdio connection without a leak', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { code: 7, kind: 'child_exit', signal: null },
        id: 'exit-during-connect',
        match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-child-exit-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await expect(client.connect(lab.endpoint.transport)).rejects.toThrow(/closed|exited/iu);
    } finally {
      await client.close().catch(() => undefined);
      await lab.close();
    }

    expect(lab.endpoint.transport.pid).toBeNull();
    expect(faultPlan.untriggeredIds()).toEqual([]);
  });

  it('accepts a stdio request but never replies when drop_response is injected', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-stdio-tool-response',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-stdio-drop-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await client.connect(lab.endpoint.transport);
      await expect(
        client.callTool(
          { arguments: { text: 'never returned' }, name: 'echo' },
          { signal: AbortSignal.timeout(100) }
        )
      ).rejects.toThrow(/abort|timeout/iu);
      await expect(
        client.callTool({ arguments: { text: 'second response' }, name: 'echo' })
      ).resolves.toMatchObject({ structuredContent: { text: 'second response' } });
    } finally {
      await client.close().catch(() => undefined);
      await lab.close();
    }

    expect(faultPlan.untriggeredIds()).toEqual([]);
  });

  it('retries a failed owned stdio close instead of reporting a leaked child as closed', async () => {
    const originalClose = StdioClientTransport.prototype.close;
    const close = vi
      .spyOn(StdioClientTransport.prototype, 'close')
      .mockRejectedValueOnce(new Error('injected stdio close failure'))
      .mockImplementation(function (this: StdioClientTransport) {
        return originalClose.call(this);
      });
    const lab = await startMcpLabScenario('stdio-reference');
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    try {
      await lab.endpoint.transport.start();
      const pid = lab.endpoint.transport.pid;
      if (pid === null) {
        throw new Error('Expected the stdio fixture to expose a child pid');
      }

      await expect(lab.close()).rejects.toThrow('injected stdio close failure');
      expect(lab.closed).toBe(false);
      await expect(lab.close()).resolves.toMatchObject({ stdioTransportsClosed: 1 });
      expect(close).toHaveBeenCalledTimes(2);
      expect(lab.endpoint.transport.pid).toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      close.mockRestore();
      if (!lab.closed) {
        await lab.close();
      }
    }
  });

  it('captures child stderr without persisting its contents and owns teardown', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'child_stderr', text: 'fixture stderr details' },
        id: 'emit-child-stderr',
        match: { method: 'child/stderr', occurrence: 1, phase: 'child-process' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-stderr-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await client.connect(lab.endpoint.transport);
      await expect
        .poll(() => lab.diagnostics())
        .toEqual([
          expect.objectContaining({
            kind: 'child-stderr',
            message: expect.stringMatching(/^captured [1-9][0-9]* stderr bytes$/u),
          }),
        ]);
      expect(JSON.stringify(lab.diagnostics())).not.toContain('fixture stderr details');
    } finally {
      await client.close();
      await lab.close();
    }

    expect(lab.endpoint.transport.pid).toBeNull();
    expect(faultPlan.untriggeredIds()).toEqual([]);
  });

  it('executes every accepted operation fault through a real protocol request', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'subscribe-status',
        match: { method: 'resources/subscribe', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    const response = await fetch(lab.endpoint.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'resources/subscribe',
        params: { uri: 'file:///fixture.txt' },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(418);
    await expect(lab.close()).resolves.toMatchObject({ untriggeredFaultIds: [] });
  });

  it('rejects an mcp-method header instead of consuming a body-mismatched fault', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'tools-call-only',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan,
    });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await expect(
      lab.endpoint.fetch(lab.endpoint.url, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
        headers: { 'content-type': 'application/json', 'mcp-method': 'tools/call' },
        method: 'POST',
      })
    ).rejects.toThrow(/mcp-method.*match.*JSON-RPC body/i);
    expect(faultPlan.untriggeredIds()).toEqual(['tools-call-only']);

    const getResponse = await lab.endpoint.fetch(lab.endpoint.url, {
      headers: { 'mcp-method': 'tools/call' },
      method: 'GET',
    });
    expect(getResponse.status).not.toBe(418);
    expect(faultPlan.untriggeredIds()).toEqual(['tools-call-only']);
    await expect(lab.close()).resolves.toMatchObject({
      untriggeredFaultIds: ['tools-call-only'],
    });
  });

  it('rejects unsafe caller correlation ids before they reach diagnostics or faults', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'safe-fault-id',
        match: { method: 'http/request', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan,
    });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    const credential = 'Authorization: Bearer opaque-secret';

    await expect(
      lab.endpoint.fetch(lab.endpoint.url, {
        headers: { 'x-mcp-lab-correlation-id': credential },
      })
    ).rejects.toThrow(/correlation id/i);
    expect(JSON.stringify(lab.diagnostics())).not.toContain(credential);
    expect(faultPlan.untriggeredIds()).toEqual(['safe-fault-id']);
    await expect(lab.close()).resolves.toMatchObject({
      untriggeredFaultIds: ['safe-fault-id'],
    });
  });

  it('drops the socket when a response fault reaches the outer loopback boundary', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'reject-dispatch',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await expect(fetch(lab.endpoint.url)).rejects.toThrow();
    expect(lab.diagnostics()).toEqual([
      expect.objectContaining({
        correlationId: 'modern-reference:exchange:1',
        kind: 'handler-error',
        message: expect.stringContaining('reject-dispatch'),
      }),
    ]);
    await expect(lab.close()).resolves.toMatchObject({ untriggeredFaultIds: [] });
  });

  it('keeps failed cleanup retryable and reports closed only after every resource closes', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'cleanup_error' },
        id: 'fail-first-close',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'delay-retried-close',
        match: { method: 'transport/close', occurrence: 2, phase: 'shutdown' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await expect(lab.close()).rejects.toThrow('fail-first-close');
    expect(lab.closed).toBe(false);
    expect(lab.diagnostics()).toEqual([
      expect.objectContaining({
        kind: 'cleanup-error',
        message: expect.stringContaining('fail-first-close'),
      }),
    ]);
    expect((await fetch(lab.endpoint.url)).status).toBe(405);

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
    expect(lab.closed).toBe(true);
    await expect(fetch(lab.endpoint.url)).rejects.toThrow();
  });
});
