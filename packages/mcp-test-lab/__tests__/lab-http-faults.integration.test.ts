import { createHash } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createMcpLabFaultPlan, type McpLabFaultPlan } from '../src/faults';
import {
  type McpLabOAuthReferenceEndpoint,
  type McpLabSession,
  startMcpLabScenario,
} from '../src/lab';

const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const VERIFIER = 'brainstrike-mcp-lab-pkce-verifier-000000000000000000000000';

function protocolInit(method: string, id = 1): RequestInit {
  const params = {
    _meta: {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'brainstrike-fault-test', version: '1' },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    },
  };
  return {
    body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
    headers: {
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
    },
    method: 'POST',
  };
}

function registrationInit(): RequestInit {
  return {
    body: JSON.stringify({
      application_type: 'native',
      client_name: 'Brainstrike Fault Boundary',
      grant_types: ['authorization_code'],
      redirect_uris: [REDIRECT_URI],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

function authorizationUrl(endpoint: McpLabOAuthReferenceEndpoint, clientId: string): URL {
  const url = new URL(endpoint.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    resource: endpoint.url.href,
    response_type: 'code',
    scope: 'mcp',
    state: 'fault-boundary-state',
  }).toString();
  return url;
}

function tokenInit(
  endpoint: McpLabOAuthReferenceEndpoint,
  clientId: string,
  code: string
): RequestInit {
  return {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      resource: endpoint.url.href,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  };
}

async function issueAccessToken(endpoint: McpLabOAuthReferenceEndpoint): Promise<string> {
  const registration = await fetch(endpoint.registrationUrl, registrationInit());
  const registered = (await registration.json()) as Readonly<Record<string, unknown>>;
  const clientId = String(registered['client_id']);
  const authorization = await fetch(authorizationUrl(endpoint, clientId), { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location') ?? 'missing:');
  const token = await fetch(
    endpoint.tokenUrl,
    tokenInit(endpoint, clientId, callback.searchParams.get('code') ?? '')
  );
  return String(((await token.json()) as Readonly<Record<string, unknown>>)['access_token']);
}

async function rawPostResponseBytes(url: URL, init: RequestInit): Promise<Uint8Array> {
  const body = String(init.body ?? '');
  const headers = new Headers(init.headers);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  const chunks: Uint8Array[] = [];
  socket.on('data', (chunk: Uint8Array) => chunks.push(chunk));
  socket.on('error', () => {
    // A reset is the expected transport-level result of a dropped response.
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(
    [
      'POST /mcp HTTP/1.1',
      `Host: ${url.host}`,
      `Origin: ${url.origin}`,
      `Content-Type: ${headers.get('content-type')}`,
      `Mcp-Method: ${headers.get('mcp-method')}`,
      `MCP-Protocol-Version: ${headers.get('mcp-protocol-version')}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n')
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('raw drop timed out')), 2000);
  });
  try {
    await Promise.race([closed, timedOut]);
    return Buffer.concat(chunks);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    socket.destroy();
  }
}

async function startPairedLabs(
  startLeft: () => Promise<McpLabSession>,
  startRight: () => Promise<McpLabSession>
): Promise<readonly [McpLabSession, McpLabSession]> {
  const left = await startLeft();
  try {
    return [left, await startRight()];
  } catch (error) {
    await left.close();
    throw error;
  }
}

function postWithAuthority(
  url: URL,
  authority: string,
  init: RequestInit
): Promise<{ readonly body: string; readonly status: number }> {
  const body = String(init.body ?? '');
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      url,
      {
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          'content-length': Buffer.byteLength(body),
          host: authority,
          origin: url.origin,
        },
        method: 'POST',
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        response.once('end', () =>
          resolve({ body: Buffer.concat(chunks).toString(), status: response.statusCode ?? 0 })
        );
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

describe('MCP HTTP fault execution', () => {
  it('consumes only a valid body/header/direction coordinate and then restores baseline', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'valid-tools-list',
        match: { method: 'tools/list', occurrence: 2, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: plan,
    });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process endpoint, received ${lab.endpoint.kind}`);
    }
    try {
      const invalidRequests = [
        new Request(lab.endpoint.url, { headers: { 'mcp-method': 'tools/list' }, method: 'GET' }),
        new Request(lab.endpoint.url, { method: 'POST' }),
        new Request(lab.endpoint.url, {
          body: '{"broken":',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      ];
      for (const request of invalidRequests) {
        await lab.endpoint.fetch(request);
        expect(plan.untriggeredIds()).toEqual(['valid-tools-list']);
      }
      const disagreement = protocolInit('tools/list');
      disagreement.headers = { ...disagreement.headers, 'mcp-method': 'tools/call' };
      expect((await lab.endpoint.fetch(lab.endpoint.url, disagreement)).status).toBe(400);
      expect(
        (await lab.endpoint.fetch(lab.endpoint.url, protocolInit('sampling/createMessage'))).status
      ).toBeGreaterThanOrEqual(400);
      expect(plan.untriggeredIds()).toEqual(['valid-tools-list']);

      expect((await lab.endpoint.fetch(lab.endpoint.url, protocolInit('tools/list'))).status).toBe(
        200
      );
      expect(plan.untriggeredIds()).toEqual(['valid-tools-list']);
      expect((await lab.endpoint.fetch(lab.endpoint.url, protocolInit('tools/list'))).status).toBe(
        418
      );
      expect(
        (await lab.endpoint.fetch(lab.endpoint.url, protocolInit('tools/list', 3))).status
      ).toBe(200);
    } finally {
      await lab.close();
    }
  });

  it('reuses the qualified parsed body instead of cloning twice', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'first-tools-list',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const [baseline, faulted] = await startPairedLabs(
      () => startMcpLabScenario('modern-reference', { execution: 'in-process' }),
      () => startMcpLabScenario('modern-reference', { execution: 'in-process', faultPlan: plan })
    );
    const clone = vi.spyOn(Request.prototype, 'clone');
    try {
      if (
        baseline.endpoint.kind !== 'in-process-http' ||
        faulted.endpoint.kind !== 'in-process-http'
      ) {
        throw new Error('Expected in-process endpoints');
      }
      await (
        await baseline.endpoint.fetch(baseline.endpoint.url, protocolInit('tools/list'))
      ).text();
      const baselineClones = clone.mock.calls.length;
      clone.mockClear();
      const response = await faulted.endpoint.fetch(
        faulted.endpoint.url,
        protocolInit('tools/list')
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: { tools: expect.any(Array) },
      });
      expect(clone).toHaveBeenCalledTimes(baselineClones);
      clone.mockClear();
      await (
        await faulted.endpoint.fetch(faulted.endpoint.url, protocolInit('tools/list', 2))
      ).text();
      expect(clone).toHaveBeenCalledTimes(baselineClones);
    } finally {
      clone.mockRestore();
      await baseline.close();
      await faulted.close();
    }
  });

  it('keeps OAuth transport and authorization faults outside authentication', async () => {
    const transportPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 503 },
        id: 'outer-request',
        match: { method: 'http/request', occurrence: 1, phase: 'transport' },
      },
    ]);
    const authorizationPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'protected-metadata-get',
        match: { method: 'oauth/protected-resource', occurrence: 1, phase: 'authorization' },
      },
    ]);
    const [transportLab, authorizationLab] = await startPairedLabs(
      () =>
        startMcpLabScenario('oauth-reference', {
          execution: 'loopback',
          faultPlan: transportPlan,
        }),
      () =>
        startMcpLabScenario('oauth-reference', {
          execution: 'loopback',
          faultPlan: authorizationPlan,
        })
    );
    try {
      if (
        transportLab.endpoint.kind !== 'oauth-loopback-http' ||
        authorizationLab.endpoint.kind !== 'oauth-loopback-http'
      ) {
        throw new Error('Expected OAuth loopback endpoints');
      }
      expect((await fetch(transportLab.endpoint.url, protocolInit('tools/list'))).status).toBe(503);
      expect((await fetch(transportLab.endpoint.url, protocolInit('tools/list', 2))).status).toBe(
        401
      );
      const wrongVerb = await fetch(authorizationLab.endpoint.protectedResourceMetadataUrl, {
        method: 'POST',
      });
      expect(wrongVerb.status).toBe(405);
      expect(authorizationPlan.untriggeredIds()).toEqual(['protected-metadata-get']);
      expect((await fetch(authorizationLab.endpoint.protectedResourceMetadataUrl)).status).toBe(
        418
      );
      expect((await fetch(authorizationLab.endpoint.protectedResourceMetadataUrl)).status).toBe(
        200
      );
    } finally {
      await transportLab.close();
      await authorizationLab.close();
    }
  });

  it('authenticates OAuth MCP work before consuming operation faults', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'authenticated-tools-list',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('oauth-reference', {
      execution: 'loopback',
      faultPlan: plan,
    });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    try {
      expect((await fetch(lab.endpoint.url, protocolInit('tools/list'))).status).toBe(401);
      expect(plan.untriggeredIds()).toEqual(['authenticated-tools-list']);
      const token = await issueAccessToken(lab.endpoint);
      const authenticated = protocolInit('tools/list', 2);
      authenticated.headers = {
        ...authenticated.headers,
        authorization: `Bearer ${token}`,
      };
      expect((await fetch(lab.endpoint.url, authenticated)).status).toBe(418);
    } finally {
      await lab.close();
    }
  });

  it('injects OAuth faults after validation but before registration, code, or token mutation', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'authorization-metadata-boundary',
        match: {
          method: 'oauth/authorization-server',
          occurrence: 1,
          phase: 'authorization',
        },
      },
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'registration-boundary',
        match: { method: 'oauth/register', occurrence: 1, phase: 'authorization' },
      },
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'authorization-boundary',
        match: { method: 'oauth/authorize', occurrence: 1, phase: 'authorization' },
      },
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'token-boundary',
        match: { method: 'oauth/token', occurrence: 1, phase: 'authorization' },
      },
    ]);
    const lab = await startMcpLabScenario('oauth-reference', {
      execution: 'loopback',
      faultPlan: plan,
    });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    try {
      expect((await fetch(lab.endpoint.authorizationServerMetadataUrl)).status).toBe(200);
      const malformed = await fetch(lab.endpoint.registrationUrl, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(malformed.status).toBe(400);
      expect(plan.untriggeredIds()).toContain('registration-boundary');

      expect((await fetch(lab.endpoint.registrationUrl, registrationInit())).status).toBe(418);
      expect(lab.endpoint.stateCounts()).toEqual({ clients: 0, codes: 0, states: 0, tokens: 0 });
      const registration = await fetch(lab.endpoint.registrationUrl, registrationInit());
      const registered = (await registration.json()) as Readonly<Record<string, unknown>>;
      const clientId = String(registered['client_id']);

      const authorize = authorizationUrl(lab.endpoint, clientId);
      expect((await fetch(authorize, { redirect: 'manual' })).status).toBe(418);
      expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 0, states: 0, tokens: 0 });
      const authorization = await fetch(authorize, { redirect: 'manual' });
      const callback = new URL(authorization.headers.get('location') ?? 'missing:');
      const code = callback.searchParams.get('code') ?? '';
      expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 1, states: 1, tokens: 0 });

      expect(
        (await fetch(lab.endpoint.tokenUrl, tokenInit(lab.endpoint, clientId, code))).status
      ).toBe(418);
      expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 1, states: 1, tokens: 0 });
      expect(
        (await fetch(lab.endpoint.tokenUrl, tokenInit(lab.endpoint, clientId, code))).status
      ).toBe(200);
      expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 0, states: 1, tokens: 1 });
      expect(plan.untriggeredIds()).toEqual([]);
    } finally {
      await lab.close();
    }
  });

  it('enforces Node-dispatch correlation and genuine dropped responses', async () => {
    const correlatedPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'correlated-dispatch',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    const dropPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-http-response',
        match: { method: 'http/response', occurrence: 1, phase: 'transport' },
      },
    ]);
    const [correlated, dropped] = await startPairedLabs(
      () =>
        startMcpLabScenario('modern-reference', {
          execution: 'loopback',
          faultPlan: correlatedPlan,
        }),
      () => startMcpLabScenario('modern-reference', { execution: 'loopback', faultPlan: dropPlan })
    );
    try {
      if (
        correlated.endpoint.kind !== 'loopback-http' ||
        dropped.endpoint.kind !== 'loopback-http'
      ) {
        throw new Error('Expected loopback endpoints');
      }
      expect(
        await postWithAuthority(
          correlated.endpoint.url,
          `localhost:${correlated.endpoint.url.port}`,
          protocolInit('tools/list')
        )
      ).toEqual({ body: '{"error":"mcp_lab_invalid_authority"}', status: 400 });
      expect(correlatedPlan.untriggeredIds()).toEqual(['correlated-dispatch']);
      const unsafeInit = protocolInit('tools/list');
      unsafeInit.headers = {
        ...unsafeInit.headers,
        'x-mcp-lab-correlation-id': 'malformed id',
      };
      const unsafe = await fetch(correlated.endpoint.url, unsafeInit);
      expect(unsafe.status).toBe(400);
      expect(correlatedPlan.untriggeredIds()).toEqual(['correlated-dispatch']);
      const correlationId = 'caller-provided:1';
      expect(
        (
          await fetch(correlated.endpoint.url, {
            ...protocolInit('tools/list', 2),
            headers: {
              ...protocolInit('tools/list', 2).headers,
              'x-mcp-lab-correlation-id': correlationId,
            },
          })
        ).status
      ).toBe(418);
      expect(correlatedPlan.observations()).toEqual([
        expect.objectContaining({ correlationId, faultId: 'correlated-dispatch' }),
      ]);
      expect((await fetch(correlated.endpoint.url, protocolInit('tools/list', 3))).status).toBe(
        200
      );
      await expect(
        rawPostResponseBytes(dropped.endpoint.url, protocolInit('tools/list'))
      ).resolves.toHaveLength(0);
      expect(dropped.diagnostics()).toEqual([
        {
          correlationId: 'modern-reference:exchange:1',
          kind: 'handler-error',
          message: 'MCP lab fault "drop-http-response" dropped the response',
        },
      ]);
      expect((await fetch(dropped.endpoint.url, protocolInit('tools/list', 2))).status).toBe(200);
    } finally {
      await correlated.close();
      await dropped.close();
    }
  });

  it('rejects incompatible and structural plans at startup', async () => {
    const nodeDispatchPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'loopback-only',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    await expect(
      startMcpLabScenario('modern-reference', {
        execution: 'in-process',
        faultPlan: nodeDispatchPlan,
      })
    ).rejects.toThrow(/http-in-process transport/i);
    await expect(
      startMcpLabScenario('modern-reference', {
        execution: 'loopback',
        faultPlan: {} as McpLabFaultPlan,
      })
    ).rejects.toThrow(/invalid MCP lab fault plan/i);
    for (const [plan, expected] of [
      [
        createMcpLabFaultPlan([
          {
            fault: { delayMs: 1, kind: 'delay' },
            id: 'server-to-client',
            match: { method: 'sampling/createMessage', occurrence: 1, phase: 'operation' },
          },
        ]),
        /absent from the modern protocol registry/i,
      ],
    ] as const) {
      await expect(
        startMcpLabScenario('modern-reference', { execution: 'loopback', faultPlan: plan })
      ).rejects.toThrow(expected);
    }
    const fixtureUnreachable = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'fixture-unreachable',
        match: { method: 'resources/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    await expect(
      startMcpLabScenario('stdio-reference', { faultPlan: fixtureUnreachable })
    ).rejects.toThrow(/unsupported by fixture/i);
  });
});
