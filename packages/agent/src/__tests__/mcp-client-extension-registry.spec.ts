import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type McpClientExtensionContract,
  McpClientExtensionRegistry,
} from '../mcp/client-extension-registry';

interface ExampleImplementation {
  readonly render: () => void;
}

const EXAMPLE_CONTRACT: McpClientExtensionContract<
  '2026-08-29',
  { mode: 'strict' },
  ExampleImplementation
> = {
  id: 'com.example/complete-host',
  isCompleteImplementation: (value): value is ExampleImplementation =>
    typeof value === 'object' &&
    value !== null &&
    'render' in value &&
    typeof value.render === 'function',
  parseSettings: (value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.keys(value).length !== 1 ||
      !('mode' in value) ||
      value.mode !== 'strict'
    ) {
      throw new Error('settings must be exactly { mode: "strict" }');
    }
    return { mode: 'strict' };
  },
  version: '2026-08-29',
};

const COMPLETE_IMPLEMENTATION: ExampleImplementation = { render: () => undefined };
const EXAMPLE_REQUEST = {
  mcpNameParam: 'taskId',
  method: 'tasks/get',
  paramsSchema: z.strictObject({ taskId: z.string().min(1) }),
  protocol: '2026-07-28',
  resultSchema: z.strictObject({
    _meta: z.record(z.string(), z.unknown()).optional(),
    status: z.literal('working'),
    taskId: z.string().min(1),
  }),
} as const;
const EXAMPLE_NOTIFICATION = {
  method: 'notifications/example-task',
  paramsSchema: z.strictObject({ taskId: z.string().min(1) }),
  protocol: '2026-07-28',
} as const;
const REQUEST_EXTENSION_CONTRACT = {
  ...EXAMPLE_CONTRACT,
  isServerSettingsCompatible: (client: { mode: 'strict' }, server: { mode: 'strict' }) =>
    client.mode === server.mode,
  parseServerSettings: EXAMPLE_CONTRACT.parseSettings,
  requests: [EXAMPLE_REQUEST],
} as const;
interface FlexibleSettings {
  mode: 'loose' | 'strict';
}
const parseFlexibleSettings = (value: unknown): FlexibleSettings => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('mode' in value) ||
    (value.mode !== 'strict' && value.mode !== 'loose')
  ) {
    throw new Error('settings must contain a known mode');
  }
  return { mode: value.mode };
};
const FLEXIBLE_REQUEST_EXTENSION_CONTRACT = {
  ...REQUEST_EXTENSION_CONTRACT,
  isServerSettingsCompatible: (client: FlexibleSettings, server: FlexibleSettings) =>
    client.mode === server.mode,
  parseServerSettings: parseFlexibleSettings,
  parseSettings: parseFlexibleSettings,
} as const;

function registerUntrusted(registry: McpClientExtensionRegistry, registration: unknown): void {
  Reflect.apply(registry.register, registry, [EXAMPLE_CONTRACT, registration]);
}

describe('McpClientExtensionRegistry', () => {
  it('advertises no extensions by default', () => {
    // Matrix truthfulness (supported extension ids == what the production
    // resolver advertises) is gated against createDefaultMcpExtensionRegistry
    // in apps/desktop/src/__tests__/main/mcp-host-runtime-tasks.test.ts.
    expect(new McpClientExtensionRegistry().toClientExtensionCapabilities()).toBeUndefined();
  });

  it('projects only a registered implementation with the exact version and settings', () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(EXAMPLE_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    });

    expect(registry.toClientExtensionCapabilities()).toEqual({
      'com.example/complete-host': { mode: 'strict' },
    });
  });

  it('prepares only an exact registered request when both peers advertise the extension', async () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(REQUEST_EXTENSION_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    });

    const prepared = await registry.prepareRequest(
      EXAMPLE_REQUEST,
      { taskId: 'task-123' },
      { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
      '2026-07-28'
    );

    expect(prepared).toMatchObject({
      params: { taskId: 'task-123' },
      resultSchema: EXAMPLE_REQUEST.resultSchema,
    });
    expect(prepared.internalMethod).not.toBe(EXAMPLE_REQUEST.method);
    expect(
      registry.rewriteOutgoingMessage({
        id: 1,
        jsonrpc: '2.0',
        method: prepared.internalMethod,
        params: prepared.params,
      })
    ).toMatchObject({ method: 'tasks/get', params: { taskId: 'task-123' } });
    expect(registry.resolveMcpName('tasks/get', prepared.params)).toBe('task-123');
  });

  it('prepares only a registered notification with compatible peer settings', () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(
      { ...REQUEST_EXTENSION_CONTRACT, notifications: [EXAMPLE_NOTIFICATION] },
      {
        implementation: COMPLETE_IMPLEMENTATION,
        settings: { mode: 'strict' },
        version: '2026-08-29',
      }
    );

    expect(
      registry.prepareNotification(
        EXAMPLE_NOTIFICATION,
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        '2026-07-28'
      )
    ).toEqual({
      method: EXAMPLE_NOTIFICATION.method,
      paramsSchema: EXAMPLE_NOTIFICATION.paramsSchema,
    });
    expect(() => registry.prepareNotification(EXAMPLE_NOTIFICATION, {}, '2026-07-28')).toThrow(
      'does not advertise extension'
    );
    expect(() =>
      new McpClientExtensionRegistry().prepareNotification(
        EXAMPLE_NOTIFICATION,
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        '2026-07-28'
      )
    ).toThrow('is not registered');
  });

  it.each([
    'notifications/initialized',
    'notifications/cancelled',
    'notifications/progress',
    // Review of #2913: the SDK consumes acknowledgements before custom
    // handlers, so a contract claiming them would never fire.
    'notifications/subscriptions/acknowledged',
  ])('rejects reserved core notification method %s', (method) => {
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          notifications: [{ ...EXAMPLE_NOTIFICATION, method }],
        },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('Invalid MCP extension notification contract');
  });

  it('snapshots a request contract before untrusted callers can mutate it', async () => {
    const registry = new McpClientExtensionRegistry();
    const request = { ...EXAMPLE_REQUEST };
    registry.register(
      { ...REQUEST_EXTENSION_CONTRACT, requests: [request] },
      {
        implementation: COMPLETE_IMPLEMENTATION,
        settings: { mode: 'strict' },
        version: '2026-08-29',
      }
    );
    Reflect.set(request, 'method', 'hostile/rewritten');
    Reflect.set(request, 'mcpNameParam', 'other');
    Reflect.set(request, 'paramsSchema', z.never());
    Reflect.set(request, 'protocol', '2025-11-25');
    Reflect.set(request, 'resultSchema', z.never());

    const prepared = await registry.prepareRequest(
      request,
      { taskId: 'task-123' },
      { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
      '2026-07-28'
    );
    expect(
      registry.rewriteOutgoingMessage({
        id: 1,
        jsonrpc: '2.0',
        method: prepared.internalMethod,
        params: prepared.params,
      })
    ).toMatchObject({ method: 'tasks/get' });
    expect(registry.resolveMcpName('tasks/get', prepared.params)).toBe('task-123');
    expect(prepared.resultSchema).toBe(EXAMPLE_REQUEST.resultSchema);
  });

  it('rejects reusing one request contract identity across extension registrations', () => {
    const registry = new McpClientExtensionRegistry();
    const request = { ...EXAMPLE_REQUEST };
    registry.register(
      { ...REQUEST_EXTENSION_CONTRACT, requests: [request] },
      {
        implementation: COMPLETE_IMPLEMENTATION,
        settings: { mode: 'strict' },
        version: '2026-08-29',
      }
    );
    Reflect.set(request, 'method', 'tasks/update');

    expect(() =>
      registry.register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          id: 'com.example/second-host',
          requests: [request],
        },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('request contract is already registered');
  });

  it('fails visibly for invalid params, absent server support, and unregistered contracts', async () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(REQUEST_EXTENSION_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    });

    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: '' },
        {
          [EXAMPLE_CONTRACT.id]: { mode: 'strict' },
        },
        '2026-07-28'
      )
    ).rejects.toThrow('failed schema validation');
    await expect(
      registry.prepareRequest(EXAMPLE_REQUEST, { taskId: 'task-123' }, {}, '2026-07-28')
    ).rejects.toThrow('does not advertise extension');
    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'loose' } },
        '2026-07-28'
      )
    ).rejects.toThrow('settings must be exactly');
    await expect(
      new McpClientExtensionRegistry().prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        '2026-07-28'
      )
    ).rejects.toThrow('is not registered');
  });

  it('rejects request methods that are duplicated, malformed, or lack server validation', () => {
    const registration = {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' as const },
      version: '2026-08-29' as const,
    };
    expect(() =>
      new McpClientExtensionRegistry().register(
        { ...EXAMPLE_CONTRACT, requests: [EXAMPLE_REQUEST] },
        registration
      )
    ).toThrow('must validate server settings');
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          requests: [EXAMPLE_REQUEST, { ...EXAMPLE_REQUEST }],
        },
        registration
      )
    ).toThrow('duplicated');
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          requests: [{ ...EXAMPLE_REQUEST, method: 'tasks get' }],
        },
        registration
      )
    ).toThrow('Invalid MCP extension request method');
  });

  it.each([
    'server/discover',
    'tools/call',
    'resources/read',
    'subscriptions/listen',
    'notifications/tasks',
  ])('rejects active core or notification request method %s', (method) => {
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          requests: [{ ...EXAMPLE_REQUEST, method }],
        },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('reserved MCP method namespace');
  });

  it.each([
    ['complete', 'Invalid MCP extension result type'],
    ['1task', 'Invalid MCP extension result type'],
    ['', 'Invalid MCP extension result type'],
  ])(
    'rejects tools/call result augmentation with discriminator %j',
    (extensionResultType, message) => {
      // Review of #2913: `complete` is the core CallToolResult discriminator and
      // would rewrap every ordinary tool result; a malformed value must name
      // itself instead of claiming the target method is wrong.
      expect(() =>
        new McpClientExtensionRegistry().register(
          {
            ...REQUEST_EXTENSION_CONTRACT,
            requests: [{ ...EXAMPLE_REQUEST, extensionResultType, method: 'tools/call' }],
          },
          {
            implementation: COMPLETE_IMPLEMENTATION,
            settings: { mode: 'strict' },
            version: '2026-08-29',
          }
        )
      ).toThrow(message);
    }
  );

  it('names the target method when result augmentation is attached to a non tools/call request', () => {
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          requests: [{ ...EXAMPLE_REQUEST, extensionResultType: 'task' }],
        },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('may only target tools/call');
  });

  it('validates the captured method and protocol exactly once for accessor-backed contracts', () => {
    let methodReads = 0;
    const request = new Proxy(
      { ...EXAMPLE_REQUEST },
      {
        get(target, property, receiver) {
          if (property === 'method') {
            methodReads += 1;
            return methodReads === 1 ? 'tools/call' : 'tasks/get';
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(() =>
      new McpClientExtensionRegistry().register(
        { ...REQUEST_EXTENSION_CONTRACT, requests: [request] },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('reserved MCP method namespace');
    expect(methodReads).toBe(1);
  });

  it('requires an explicit compatibility predicate and rejects valid but incompatible settings', async () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(FLEXIBLE_REQUEST_EXTENSION_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    });

    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'loose' } },
        '2026-07-28'
      )
    ).rejects.toThrow('incompatible server settings');

    expect(() =>
      new McpClientExtensionRegistry().register(
        { ...FLEXIBLE_REQUEST_EXTENSION_CONTRACT, isServerSettingsCompatible: undefined },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('must define server settings compatibility');
  });

  it('seals an immutable capability snapshot before dispatch', async () => {
    const settings: FlexibleSettings = { mode: 'strict' };
    const registry = new McpClientExtensionRegistry();
    registry.register(FLEXIBLE_REQUEST_EXTENSION_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings,
      version: '2026-08-29',
    });

    const capabilities = registry.toClientExtensionCapabilities();
    settings.mode = 'loose';
    expect(capabilities).toEqual({ [EXAMPLE_CONTRACT.id]: { mode: 'strict' } });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities?.[EXAMPLE_CONTRACT.id])).toBe(true);
    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        '2026-07-28'
      )
    ).resolves.toMatchObject({ params: { taskId: 'task-123' } });
    expect(() =>
      registry.register(EXAMPLE_CONTRACT, {
        implementation: COMPLETE_IMPLEMENTATION,
        settings: { mode: 'strict' },
        version: '2026-08-29',
      })
    ).toThrow('sealed');
  });

  it('rejects cyclic settings with an attributable JSON error', () => {
    const cyclic: Record<string, never> = {};
    Reflect.set(cyclic, 'self', cyclic);
    const registry = new McpClientExtensionRegistry();
    registry.register(
      { ...EXAMPLE_CONTRACT, parseSettings: () => cyclic },
      {
        implementation: COMPLETE_IMPLEMENTATION,
        settings: cyclic,
        version: '2026-08-29',
      }
    );

    expect(() => registry.toClientExtensionCapabilities()).toThrow(
      'MCP client extension "com.example/complete-host" settings.self must be an acyclic JSON object'
    );
  });

  it('enforces the snapshotted request protocol inside preparation', async () => {
    const registry = new McpClientExtensionRegistry();
    registry.register(REQUEST_EXTENSION_CONTRACT, {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    });

    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        '2026-09-01'
      )
    ).rejects.toThrow('requires protocol 2026-07-28; negotiated 2026-09-01');
    await expect(
      registry.prepareRequest(
        EXAMPLE_REQUEST,
        { taskId: 'task-123' },
        { [EXAMPLE_CONTRACT.id]: { mode: 'strict' } },
        undefined
      )
    ).rejects.toThrow('requires protocol 2026-07-28; negotiated undefined');
  });

  it('does not reinterpret extension result discriminators without an augmented request', () => {
    const registry = new McpClientExtensionRegistry();
    const response = { id: 1, jsonrpc: '2.0' as const, result: { resultType: 'task' } };
    expect(registry.rewriteIncomingMessage(response)).toBe(response);
  });

  it('rejects an extension request contract for an unsupported runtime protocol', () => {
    expect(() =>
      new McpClientExtensionRegistry().register(
        {
          ...REQUEST_EXTENSION_CONTRACT,
          requests: [{ ...EXAMPLE_REQUEST, protocol: '2025-11-25' } as never],
        },
        {
          implementation: COMPLETE_IMPLEMENTATION,
          settings: { mode: 'strict' },
          version: '2026-08-29',
        }
      )
    ).toThrow('requires unsupported protocol');
  });

  it.each(['ui', '__proto__', 'constructor', 'com.example/-ui', '.example/ui'])(
    'rejects malformed or unprefixed extension identifier %s',
    (id) => {
      const registry = new McpClientExtensionRegistry();
      expect(() =>
        registry.register(
          { ...EXAMPLE_CONTRACT, id },
          {
            implementation: COMPLETE_IMPLEMENTATION,
            settings: { mode: 'strict' },
            version: '2026-08-29',
          }
        )
      ).toThrow('Invalid MCP client extension identifier');
    }
  );

  it.each([
    [
      { implementation: COMPLETE_IMPLEMENTATION, settings: { mode: 'strict' }, version: 'bad' },
      'requires version',
    ],
    [
      { implementation: COMPLETE_IMPLEMENTATION, settings: { extra: true }, version: '2026-08-29' },
      'settings must be exactly',
    ],
    [
      { implementation: {}, settings: { mode: 'strict' }, version: '2026-08-29' },
      'complete host implementation',
    ],
  ])('rejects an untrusted invalid registration', (registration, message) => {
    expect(() => registerUntrusted(new McpClientExtensionRegistry(), registration)).toThrow(
      message
    );
  });

  it('rejects duplicate extension registrations', () => {
    const registry = new McpClientExtensionRegistry();
    const registration = {
      implementation: COMPLETE_IMPLEMENTATION,
      settings: { mode: 'strict' },
      version: '2026-08-29',
    };
    registry.register(EXAMPLE_CONTRACT, registration);

    expect(() => registry.register(EXAMPLE_CONTRACT, registration)).toThrow(
      'is already registered'
    );
  });

  it('revalidates settings and implementation before each projection', () => {
    const registry = new McpClientExtensionRegistry();
    const implementation: { render?: () => void } = { render: () => undefined };
    const settings = { mode: 'strict' };
    registry.register(EXAMPLE_CONTRACT, {
      implementation,
      settings,
      version: '2026-08-29',
    });

    settings.mode = 'loose';
    expect(() => registry.toClientExtensionCapabilities()).toThrow('settings must be exactly');

    settings.mode = 'strict';
    implementation.render = undefined;
    expect(() => registry.toClientExtensionCapabilities()).toThrow(
      'does not have a complete host implementation'
    );
  });
});
