import { type Client, type ElicitRequest, specTypeSchemas } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  composeMcpTransportCapabilities,
  createMcpClientCapabilityRuntime,
  createMcpElicitationCapability,
  createMcpRootsCapability,
  DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS,
  sanitizeMcpServerLog,
  validateMcpElicitationRequest,
  validateMcpElicitationResult,
} from '../mcp/client-capabilities';

describe('MCP client capabilities', () => {
  it('composes one shared transport policy without conflating handlers and manual mode', () => {
    expect(composeMcpTransportCapabilities({})).toMatchObject({
      inputRequired: { autoFulfill: true, maxRounds: DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS },
      runtime: { capabilities: {} },
    });
    expect(
      composeMcpTransportCapabilities({
        clientCapabilities: { roots: { handle: vi.fn(), listChanged: true } },
        inputRequired: { autoFulfill: false, maxRounds: 3 },
      })
    ).toMatchObject({
      inputRequired: { autoFulfill: false, maxRounds: 3 },
      runtime: { capabilities: { roots: { listChanged: true } } },
    });
  });

  it('reports the exact conflicting or malformed input-required field', () => {
    expect(() =>
      composeMcpTransportCapabilities({
        clientCapabilities: { maxInputRequiredRounds: 2 },
        inputRequired: { maxRounds: 3 },
      })
    ).toThrow('clientCapabilities.maxInputRequiredRounds and inputRequired.maxRounds');
    expect(() =>
      composeMcpTransportCapabilities({
        inputRequired: { autoFulfill: 'yes' as never },
      })
    ).toThrow('inputRequired.autoFulfill must be a boolean');
    expect(() => composeMcpTransportCapabilities({ inputRequired: { maxRounds: 0 } })).toThrow(
      'inputRequired.maxRounds must be a positive safe integer'
    );
  });

  it('advertises only complete handlers and keeps deprecated capabilities independently gated', () => {
    expect(
      createMcpClientCapabilityRuntime({
        elicitation: { form: true, handle: vi.fn(), url: false },
      }).capabilities
    ).toEqual({ elicitation: { form: {} } });
    expect(
      createMcpClientCapabilityRuntime({
        roots: { handle: vi.fn(), listChanged: false },
        sampling: { handle: vi.fn() },
      }).capabilities
    ).toEqual({ roots: { listChanged: false }, sampling: {} });
    expect(createMcpClientCapabilityRuntime({}).capabilities).toEqual({});
  });

  it('uses a finite host round policy at or below the SDK cap', () => {
    expect(createMcpClientCapabilityRuntime({}).inputRequired).toEqual({
      autoFulfill: true,
      maxRounds: DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS,
    });
    expect(() => createMcpClientCapabilityRuntime({ maxInputRequiredRounds: 11 })).toThrow(
      'at most 10'
    );
    expect(() => createMcpClientCapabilityRuntime({ maxInputRequiredRounds: 0 })).toThrow(
      'positive safe integer'
    );
  });

  it('fails closed when elicitation declares no supported mode', () => {
    expect(() =>
      createMcpClientCapabilityRuntime({
        elicitation: { form: false, handle: vi.fn(), url: false },
      })
    ).toThrow('at least one mode');
  });

  it('registers one elicitation handler for modern and legacy delivery', async () => {
    const decisions: string[] = [];
    const runtime = createMcpClientCapabilityRuntime({
      elicitation: {
        form: true,
        handle: async (_request, context) => {
          decisions.push(`${context.serverName}:${String(context.requestId)}`);
          return { action: 'decline' };
        },
        url: false,
      },
    });
    const handlers = new Map<
      string,
      (request: ElicitRequest, context: unknown) => Promise<unknown>
    >();
    const client = {
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((method: string, handler: unknown) => {
        handlers.set(
          method,
          handler as (request: ElicitRequest, context: unknown) => Promise<unknown>
        );
      }),
    } as unknown as Client;
    runtime.install(client, 'calendar');
    const handler = handlers.get('elicitation/create');
    const request = {
      method: 'elicitation/create',
      params: {
        message: 'Continue?',
        requestedSchema: { properties: {}, type: 'object' },
      },
    } satisfies ElicitRequest;
    const context = { mcpReq: { id: 'legacy-1', signal: new AbortController().signal } };

    await expect(handler?.(request, context)).resolves.toEqual({ action: 'decline' });
    await expect(
      handler?.(request, { mcpReq: { ...context.mcpReq, id: 'modern-1' } })
    ).resolves.toEqual({ action: 'decline' });
    expect(decisions).toEqual(['calendar:legacy-1', 'calendar:modern-1']);
  });

  it('returns a per-connection lease that aborts, removes, and settles active handlers exactly', async () => {
    let releaseHandler: (() => void) | undefined;
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handlers = new Map<string, (request: unknown, context: unknown) => Promise<unknown>>();
    const client = {
      removeNotificationHandler: vi.fn(),
      removeRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((method: string, handler: unknown) => {
        handlers.set(method, handler as (request: unknown, context: unknown) => Promise<unknown>);
      }),
    } as unknown as Client;
    const runtime = createMcpClientCapabilityRuntime({
      logging: { handle: vi.fn(), minimumLevel: 'warning' },
      roots: { handle: async () => ({ roots: [] }), listChanged: false },
      sampling: {
        handle: async (_request, context) => {
          markHandlerStarted?.();
          expect(context.signal.aborted).toBe(false);
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await handlerReleased;
          return { content: { text: 'stopped', type: 'text' }, model: 'test', role: 'assistant' };
        },
      },
    });
    const lease = runtime.install(client, 'calendar');
    const request = handlers.get('sampling/createMessage')?.(
      { method: 'sampling/createMessage', params: { maxTokens: 1, messages: [] } },
      { mcpReq: { id: 1, signal: new AbortController().signal } }
    );
    await handlerStarted;

    const close = lease.close();
    expect(client.removeRequestHandler).toHaveBeenCalledTimes(2);
    expect(client.removeNotificationHandler).toHaveBeenCalledExactlyOnceWith(
      'notifications/message'
    );
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseHandler?.();

    await expect(request).resolves.toMatchObject({ model: 'test' });
    await expect(close).resolves.toEqual({
      activeHandlerCallsAtClose: 1,
      handlerCallsSettled: 1,
      notificationHandlersRemoved: 1,
      requestHandlersRemoved: 2,
    });
    await expect(lease.close()).resolves.toEqual({
      activeHandlerCallsAtClose: 1,
      handlerCallsSettled: 1,
      notificationHandlersRemoved: 1,
      requestHandlersRemoved: 2,
    });
  });

  it('bounds and redacts remote log data without accepting remote scopes', () => {
    expect(
      sanitizeMcpServerLog({
        data: {
          Authorization: 'Bearer secret-value',
          nested: { apiKey: 'sk-secret', safe: 'kept' },
          scope: 'BrainstrikeSecurity',
        },
        level: 'warning',
        logger: 'RemoteScope',
      })
    ).toEqual({
      data: {
        Authorization: '[REDACTED]',
        nested: { apiKey: '[REDACTED]', safe: 'kept' },
        scope: 'BrainstrikeSecurity',
      },
      level: 'warning',
      remoteLogger: 'RemoteScope',
    });
    expect(() => sanitizeMcpServerLog({ data: 'x'.repeat(32_769), level: 'info' })).toThrow(
      'exceeds 32768 bytes'
    );
  });

  it.each([
    ['property', { password: { type: 'string' } }, true],
    ['title', { value: { title: 'API key', type: 'string' } }, true],
    ['format', { value: { format: 'credential', type: 'string' } }, true],
    ['nested property', { value: { properties: { client_secret: { type: 'string' } } } }, true],
    ['description', { value: { description: 'Track token budget', type: 'string' } }, false],
  ])('classifies sensitive form schema %s exactly', (_label, properties, rejected) => {
    const validate = () =>
      validateMcpElicitationRequest({
        method: 'elicitation/create',
        params: { message: 'Provide value', requestedSchema: { properties, type: 'object' } },
      } as ElicitRequest);
    if (rejected) {
      expect(validate).toThrow('may not request sensitive');
    } else {
      expect(validate).not.toThrow();
    }
  });

  it('bounds accepted form responses by serialized UTF-8 bytes', () => {
    const request = {
      method: 'elicitation/create',
      params: {
        message: 'Value?',
        requestedSchema: { properties: { value: { type: 'string' } }, type: 'object' },
      },
    } satisfies ElicitRequest;
    expect(() =>
      validateMcpElicitationResult(request, {
        action: 'accept',
        content: { value: '😀'.repeat(9000) },
      })
    ).toThrow('response exceeds 32768 bytes');
  });

  it('opens a strict HTTPS URL only after an explicit accept decision', async () => {
    const openExternal = vi.fn(async () => undefined);
    const confirmUrl = vi
      .fn()
      .mockResolvedValueOnce({ action: 'decline' })
      .mockResolvedValueOnce({ action: 'accept' });
    const capability = createMcpElicitationCapability({
      confirmUrl,
      form: false,
      openExternal,
      presentForm: vi.fn(),
      url: true,
    });
    const request = {
      method: 'elicitation/create',
      params: {
        elicitationId: 'calendar-auth',
        message: 'Authorize calendar',
        mode: 'url',
        url: 'https://calendar.example/auth',
      },
    } satisfies ElicitRequest;
    const context = {
      requestId: 'request-1',
      serverName: 'calendar',
      signal: new AbortController().signal,
    };

    await expect(capability.handle(request, context)).resolves.toEqual({ action: 'decline' });
    expect(openExternal).not.toHaveBeenCalled();
    await expect(capability.handle(request, context)).resolves.toEqual({ action: 'accept' });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      new URL('https://calendar.example/auth'),
      context
    );
  });

  it('advertises elicitation default application only when explicitly enabled', () => {
    const elicitation = {
      applyDefaults: true,
      form: true,
      handle: vi.fn(async () => ({ action: 'accept' as const, content: {} })),
      url: false,
    };

    expect(createMcpClientCapabilityRuntime({ elicitation }).capabilities).toEqual({
      elicitation: { form: { applyDefaults: true } },
    });
    expect(
      createMcpClientCapabilityRuntime({
        elicitation: { ...elicitation, applyDefaults: undefined },
      }).capabilities
    ).toEqual({ elicitation: { form: {} } });
  });

  it('rejects elicitation default application without form mode', () => {
    expect(() =>
      createMcpClientCapabilityRuntime({
        elicitation: {
          applyDefaults: true,
          form: false,
          handle: vi.fn(),
          url: true,
        },
      })
    ).toThrow('default application requires form mode');
  });

  it.each([
    'http://calendar.example/auth',
    'ftp://calendar.example/auth',
    'https://user:password@calendar.example/auth',
  ])('rejects unsafe URL elicitation before consent through both entry points: %s', async (url) => {
    const confirmUrl = vi.fn();
    const capability = createMcpElicitationCapability({
      confirmUrl,
      form: false,
      openExternal: vi.fn(),
      presentForm: vi.fn(),
      url: true,
    });
    const request = {
      method: 'elicitation/create',
      params: { elicitationId: 'unsafe', message: 'Open?', mode: 'url', url },
    } as ElicitRequest;
    const context = {
      requestId: 'request-1',
      serverName: 'calendar',
      signal: new AbortController().signal,
    };

    await expect(capability.handle(request, context)).rejects.toThrow('requires HTTPS');
    expect(confirmUrl).not.toHaveBeenCalled();

    const handlers = new Map<
      string,
      (value: ElicitRequest, context: unknown) => Promise<unknown>
    >();
    const client = {
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((method: string, handler: unknown) => {
        handlers.set(
          method,
          handler as (value: ElicitRequest, context: unknown) => Promise<unknown>
        );
      }),
    } as unknown as Client;
    const runtime = createMcpClientCapabilityRuntime({ elicitation: capability });
    runtime.install(client, 'calendar');
    await expect(
      handlers.get('elicitation/create')?.(request, {
        mcpReq: { id: 1, signal: new AbortController().signal },
      })
    ).rejects.toThrow('requires HTTPS');
    expect(confirmUrl).not.toHaveBeenCalled();
  });

  it('allows HTTP only for explicit loopback development policy', async () => {
    const openExternal = vi.fn(async () => undefined);
    const capability = createMcpElicitationCapability({
      confirmUrl: vi.fn(async () => ({ action: 'accept' as const })),
      form: false,
      openExternal,
      presentForm: vi.fn(),
      url: true,
      urlPolicy: 'https-or-loopback-http-development',
    });
    const context = {
      requestId: 1,
      serverName: 'development',
      signal: new AbortController().signal,
    };
    const loopbackRequest = {
      method: 'elicitation/create',
      params: {
        elicitationId: 'local',
        message: 'Open local callback?',
        mode: 'url',
        url: 'http://127.0.0.1:43123/callback',
      },
    } satisfies ElicitRequest;

    await expect(capability.handle(loopbackRequest, context)).resolves.toEqual({
      action: 'accept',
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      new URL('http://127.0.0.1:43123/callback'),
      context
    );
    await expect(
      capability.handle(
        {
          ...loopbackRequest,
          params: { ...loopbackRequest.params, url: 'http://example.com/callback' },
        },
        context
      )
    ).rejects.toThrow('requires HTTPS');
  });

  it('rejects unknown elicitation modes instead of treating them as form mode', async () => {
    const presentForm = vi.fn();
    const capability = createMcpElicitationCapability({
      confirmUrl: vi.fn(),
      form: true,
      openExternal: vi.fn(),
      presentForm,
      url: true,
    });
    await expect(
      capability.handle(
        {
          method: 'elicitation/create',
          params: { message: 'Unknown', mode: 'future', requestedSchema: {} },
        } as unknown as ElicitRequest,
        {
          requestId: 1,
          serverName: 'calendar',
          signal: new AbortController().signal,
        }
      )
    ).rejects.toThrow('Unsupported MCP elicitation mode');
    expect(presentForm).not.toHaveBeenCalled();
  });

  it.each([
    ['email', 'not-an-email'],
    ['uri', 'relative/path'],
    ['date', '2025-02-29'],
    ['date-time', '2025-01-01T12:00:00'],
  ] as const)(
    'rejects accepted form content that violates the %s format',
    async (format, value) => {
      const handlers = new Map<
        string,
        (value: ElicitRequest, context: unknown) => Promise<unknown>
      >();
      const client = {
        setNotificationHandler: vi.fn(),
        setRequestHandler: vi.fn((method: string, handler: unknown) => {
          handlers.set(
            method,
            handler as (value: ElicitRequest, context: unknown) => Promise<unknown>
          );
        }),
      } as unknown as Client;
      const runtime = createMcpClientCapabilityRuntime({
        elicitation: {
          form: true,
          handle: async () => ({ action: 'accept', content: { value } }),
          url: false,
        },
      });
      runtime.install(client, 'calendar');
      const request = {
        method: 'elicitation/create',
        params: {
          message: 'Value?',
          requestedSchema: {
            properties: { value: { format, type: 'string' } },
            required: ['value'],
            type: 'object',
          },
        },
      } satisfies ElicitRequest;

      await expect(
        handlers.get('elicitation/create')?.(request, {
          mcpReq: { id: 1, signal: new AbortController().signal },
        })
      ).rejects.toThrow(`does not match format "${format}"`);
    }
  );

  it('accepts canonical string formats and enum-backed multiselect content', async () => {
    const handlers = new Map<
      string,
      (value: ElicitRequest, context: unknown) => Promise<unknown>
    >();
    const client = {
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((method: string, handler: unknown) => {
        handlers.set(
          method,
          handler as (value: ElicitRequest, context: unknown) => Promise<unknown>
        );
      }),
    } as unknown as Client;
    const content = {
      date: '2024-02-29',
      dateTime: '2024-02-29T23:59:60Z',
      email: 'valid.user+tag@example.com',
      selections: ['one', 'two'],
      uri: 'urn:example:calendar',
    };
    createMcpClientCapabilityRuntime({
      elicitation: {
        form: true,
        handle: async () => ({ action: 'accept', content }),
        url: false,
      },
    }).install(client, 'calendar');
    const request = {
      method: 'elicitation/create',
      params: {
        message: 'Values?',
        requestedSchema: {
          properties: {
            date: { format: 'date', type: 'string' },
            dateTime: { format: 'date-time', type: 'string' },
            email: { format: 'email', type: 'string' },
            selections: {
              items: { enum: ['one', 'two'], type: 'string' },
              type: 'array',
            },
            uri: { format: 'uri', type: 'string' },
          },
          required: ['date', 'dateTime', 'email', 'selections', 'uri'],
          type: 'object',
        },
      },
    } satisfies ElicitRequest;

    await expect(
      handlers.get('elicitation/create')?.(request, {
        mcpReq: { id: 1, signal: new AbortController().signal },
      })
    ).resolves.toEqual({ action: 'accept', content });
  });

  it('keeps unconstrained arrays outside the SDK elicitation schema', async () => {
    const validation = await specTypeSchemas.ElicitRequest['~standard'].validate({
      method: 'elicitation/create',
      params: {
        message: 'Values?',
        requestedSchema: {
          properties: { values: { items: { type: 'string' }, type: 'array' } },
          type: 'object',
        },
      },
    });

    expect(validation).toHaveProperty('issues');
    expect(
      await specTypeSchemas.ElicitRequest['~standard'].validate({
        method: 'elicitation/create',
        params: {
          message: 'Values?',
          requestedSchema: {
            properties: {
              values: { items: { enum: ['one'], type: 'string' }, type: 'array' },
            },
            type: 'object',
          },
        },
      })
    ).toHaveProperty('value');
  });

  it('snapshots only explicit file roots and never treats them as an access grant', async () => {
    const capability = createMcpRootsCapability({
      listChanged: true,
      roots: [{ name: 'Workspace', uri: 'file:///workspace/project' }],
    });
    await expect(
      capability.handle({
        requestId: 1,
        serverName: 'filesystem',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ roots: [{ name: 'Workspace', uri: 'file:///workspace/project' }] });
    expect(() =>
      createMcpRootsCapability({
        listChanged: false,
        roots: [{ name: 'Remote', uri: 'https://example.com/workspace' }],
      })
    ).toThrow('file: URI');
  });
});
