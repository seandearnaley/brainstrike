import { createMcpElicitationCapability } from '@brainstrike/agent/mcp-client';
import {
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpElicitationPresentation,
  McpElicitationPresenterAuthority,
} from '../../mcp/elicitation-presenter';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const connectedServer = (): McpHostServerSnapshot => ({
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 7,
  negotiated: {
    era: 'modern',
    revision: '2026-07-28',
    serverIdentity: {
      name: 'Linear MCP',
      title: 'Linear',
      version: '2.0.0',
      websiteUrl: 'https://linear.example/about?token=must-not-project',
    },
  },
  state: 'connected',
  transport: 'streamable-http',
});
const formRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Choose a workspace',
    mode: 'form',
    requestedSchema: {
      properties: { workspace: { type: 'string' } },
      required: ['workspace'],
      type: 'object',
    },
  },
} satisfies ElicitRequest;

describe('McpElicitationPresenterAuthority', () => {
  it('rejects invalid or sensitive form data without consuming a correctable presentation', async () => {
    const presentations: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach((value) => presentations.push(value));
    const operation = { configuredServerId: SERVER_ID, type: 'tools/list' } as const;
    const pending = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, {
        requestId: 'correctable',
        serverName: SERVER_ID,
        signal: new AbortController().signal,
      })
    );
    const settlement = {
      action: 'accept' as const,
      configuredServerId: SERVER_ID,
      generation: 7,
      id: presentations[0]?.id,
      requestId: 'correctable',
    };
    expect(() => authority.settle({ ...settlement, content: { workspace: 42 } })).toThrowError(
      expect.objectContaining({ code: 'mcp-elicitation-settlement-invalid' })
    );
    authority.settle({ ...settlement, content: { workspace: 'Engineering' } });
    await expect(pending).resolves.toMatchObject({ content: { workspace: 'Engineering' } });
    const invalidRequests: Parameters<typeof authority.presenter.presentForm>[0][] = [
      { ...formRequest, params: { ...formRequest.params, message: 'x'.repeat(33_000) } },
      {
        ...formRequest,
        params: {
          ...formRequest.params,
          requestedSchema: {
            properties: { value: { description: 'Paste API token', type: 'string' } },
            type: 'object' as const,
          },
        },
      },
      {
        ...formRequest,
        params: { ...formRequest.params, requestedSchema: {} },
      } as unknown as Parameters<typeof authority.presenter.presentForm>[0],
    ];
    for (const invalidRequest of invalidRequests) {
      await expect(
        authority.runWithOperation(operation, () =>
          authority.presenter.presentForm(invalidRequest, {
            requestId: 'sensitive',
            serverName: SERVER_ID,
            signal: new AbortController().signal,
          })
        )
      ).rejects.toMatchObject({ code: 'mcp-elicitation-request-invalid' });
    }
    expect(presentations).toHaveLength(1);
  });
  it('presents exact provenance and settles an accepted form exactly once', async () => {
    let presentation: McpElicitationPresentation | undefined;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => '00000000-0000-4000-8000-000000000001',
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach((value) => {
      presentation = value;
    });
    const result = authority.runWithOperation(
      {
        arguments: { query: 'private model input' },
        configuredServerId: SERVER_ID,
        toolName: 'search_issues',
        type: 'tools/call',
      },
      () =>
        authority.presenter.presentForm(formRequest, {
          requestId: 'elicitation-1',
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        })
    );
    expect(presentation).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      message: 'Choose a workspace',
      mode: 'form',
      provenance: {
        configuredProtocol: '2026-07-28',
        configuredServerId: SERVER_ID,
        generation: 7,
        invocationId: expect.any(String),
        negotiatedRevision: '2026-07-28',
        operation: { target: 'search_issues', type: 'tools/call' },
        requestId: 'elicitation-1',
        serverIdentity: {
          name: 'Linear MCP',
          title: 'Linear',
          version: '2.0.0',
          websiteOrigin: 'https://linear.example',
        },
        transport: 'streamable-http',
      },
      requestedSchema: formRequest.params.requestedSchema,
    });
    authority.settle({
      action: 'accept',
      configuredServerId: SERVER_ID,
      content: { workspace: 'Engineering' },
      generation: 7,
      id: presentation?.id,
      requestId: 'elicitation-1',
    });
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    expect(() =>
      authority.settle({
        action: 'decline',
        configuredServerId: SERVER_ID,
        generation: 7,
        id: presentation?.id,
        requestId: 'elicitation-1',
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-already-settled' }));
  });
  it('opens a safe URL only after an exact one-use accept decision', async () => {
    const presentations: McpElicitationPresentation[] = [];
    const openExternal = vi.fn(async () => undefined);
    let sequence = 1;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      openExternal,
      resolveServer: () => connectedServer(),
    });
    authority.attach((value) => presentations.push(value));
    const capability = createMcpElicitationCapability(authority.presenter);
    const operation = {
      configuredServerId: SERVER_ID,
      name: 'connect-account',
      type: 'prompts/get',
    } as const;
    const request = {
      method: 'elicitation/create',
      params: {
        elicitationId: 'third-party-connect',
        message: 'Connect your account',
        mode: 'url',
        url: 'https://accounts.example/connect?state=opaque&code_challenge=safe',
      },
    } satisfies ElicitRequest;
    const invoke = (requestId: string) =>
      authority.runWithOperation(operation, () =>
        capability.handle(request, {
          requestId,
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        })
      );
    const declined = invoke('url-decline');
    expect(presentations[0]).toMatchObject({
      mode: 'url',
      url: request.params.url,
    });
    authority.settle({
      action: 'decline',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: presentations[0]?.id,
      requestId: 'url-decline',
    });
    await expect(declined).resolves.toEqual({ action: 'decline' });
    expect(openExternal).not.toHaveBeenCalled();
    const accepted = invoke('url-accept');
    authority.settle({
      action: 'accept',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: presentations[1]?.id,
      requestId: 'url-accept',
    });
    await expect(accepted).resolves.toEqual({ action: 'accept' });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(new URL(request.params.url));
    await expect(
      authority.runWithOperation(operation, () =>
        authority.presenter.openExternal(new URL(request.params.url), {
          requestId: 'url-accept',
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        })
      )
    ).rejects.toMatchObject({ code: 'mcp-elicitation-url-not-authorized' });
    const concurrent = [invoke('same-input-key'), invoke('same-input-key')];
    const pair = presentations.slice(-2);
    expect(pair[0]?.provenance.invocationId).not.toBe(pair[1]?.provenance.invocationId);
    for (const presentation of pair) {
      authority.settle({
        action: 'accept',
        configuredServerId: SERVER_ID,
        generation: 7,
        id: presentation?.id,
        requestId: 'same-input-key',
      });
    }
    await expect(Promise.all(concurrent)).resolves.toEqual([
      { action: 'accept' },
      { action: 'accept' },
    ]);
    openExternal.mockRejectedValueOnce(new Error('opener failed'));
    const failedOpen = invoke('opener-failure');
    const failedPresentation = presentations.at(-1);
    authority.settle({
      action: 'accept',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: failedPresentation?.id,
      requestId: 'opener-failure',
    });
    await expect(failedOpen).rejects.toThrow('opener failed');
  });
  it('bounds pending and finalized authority while rejecting generated-id collisions', async () => {
    const ids: string[] = [];
    const seen: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => ids.shift() ?? 'missing-id',
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    const attach = () => authority.attach((presentation) => seen.push(presentation));
    let detach = attach();
    const present = (id: string) => {
      ids.push(id);
      return authority.runWithOperation({ configuredServerId: SERVER_ID, type: 'tools/list' }, () =>
        authority.presenter.presentForm(formRequest, {
          requestId: id,
          serverName: SERVER_ID,
          signal: new AbortController().signal,
        })
      );
    };
    const pending = Array.from({ length: 32 }, (_, index) => present(`p${index}`));
    await expect(present('overflow')).rejects.toMatchObject({
      code: 'mcp-elicitation-settlement-invalid',
    });
    detach();
    expect((await Promise.allSettled(pending)).every(({ status }) => status === 'rejected')).toBe(
      true
    );
    detach = attach();
    for (let index = 0; index < 97; index++) {
      const result = present(`f${index}`);
      authority.settle({
        action: 'cancel',
        configuredServerId: SERVER_ID,
        generation: 7,
        id: seen.at(-1)?.id,
        requestId: `f${index}`,
      });
      await result;
    }
    const reused = present('p0');
    await expect(present('p0')).rejects.toMatchObject({
      code: 'mcp-elicitation-settlement-invalid',
    });
    detach();
    await expect(reused).rejects.toMatchObject({ code: 'mcp-elicitation-presenter-unavailable' });
  });
  it('settles caller abort, authority retirement, close, and restart without resumable state', async () => {
    let server = connectedServer();
    const presentations: McpElicitationPresentation[] = [];
    let sequence = 10;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      openExternal: vi.fn(),
      resolveServer: () => server,
    });
    authority.attach((value) => presentations.push(value));
    const operation = {
      configuredServerId: SERVER_ID,
      type: 'tools/list',
    } as const;
    const present = (requestId: string, signal: AbortSignal) =>
      authority.runWithOperation(operation, () =>
        authority.presenter.presentForm(formRequest, { requestId, serverName: SERVER_ID, signal })
      );
    const caller = new AbortController();
    const aborted = present('abort-me', caller.signal);
    const abortedResult = expect(aborted).rejects.toMatchObject({
      code: 'mcp-elicitation-caller-aborted',
    });
    caller.abort();
    await abortedResult;
    const retired = present('retire-me', new AbortController().signal);
    const retiredId = presentations.at(-1)?.id;
    const retiredResult = expect(retired).rejects.toMatchObject({
      code: 'mcp-elicitation-authority-retired',
    });
    authority.retireServer(SERVER_ID, 7);
    await retiredResult;
    expect(() =>
      authority.settle({
        action: 'cancel',
        configuredServerId: SERVER_ID,
        generation: 7,
        id: retiredId,
        requestId: 'retire-me',
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-stale-authority' }));
    server = { ...connectedServer(), generation: 8 };
    const closing = present('close-me', new AbortController().signal);
    const closingId = presentations.at(-1)?.id;
    const closingResult = expect(closing).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-closed',
    });
    authority.close();
    await closingResult;
    const restarted = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => server,
    });
    expect(() =>
      restarted.settle({
        action: 'accept',
        configuredServerId: SERVER_ID,
        content: { workspace: 'stale' },
        generation: 8,
        id: closingId,
        requestId: 'close-me',
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-settlement-invalid' }));
  });
});
