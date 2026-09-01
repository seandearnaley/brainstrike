import type { Transport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpClientExtensionRegistry } from '../mcp/client-extension-registry';
import {
  applyRegisteredExtensionHttpHeaders,
  encodeMcpHeaderValue,
  installRegisteredExtensionDispatch,
} from '../mcp/registered-extension-dispatch';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_REQUEST,
} from './fixtures/mcp-client-extension-registry';

function registeredRegistry() {
  const extension = createDeferredTestExtension();
  extension.register();
  return extension.registry;
}

function registryWithoutMcpName(): McpClientExtensionRegistry {
  const registry = new McpClientExtensionRegistry();
  const settings = { mode: 'strict' } as const;
  const implementation = { ready: true } as const;
  registry.register(
    {
      id: 'com.example/no-name-host',
      isCompleteImplementation: (value): value is typeof implementation => value === implementation,
      isServerSettingsCompatible: (client, server) => client.mode === server.mode,
      parseServerSettings: (value) => z.strictObject({ mode: z.literal('strict') }).parse(value),
      parseSettings: (value) => z.strictObject({ mode: z.literal('strict') }).parse(value),
      requests: [
        {
          method: 'tasks/update',
          paramsSchema: z.strictObject({ taskId: z.string().min(1) }),
          protocol: '2026-07-28',
          resultSchema: z.strictObject({ accepted: z.boolean() }),
        },
      ],
      version: '2026-08-29',
    },
    { implementation, settings, version: '2026-08-29' }
  );
  return registry;
}

describe('registered extension HTTP dispatch', () => {
  it('reports rewrite failures through the transport promise', async () => {
    const transport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    } as unknown as Transport;
    const registry = {
      rewriteOutgoingMessage: () => {
        throw new Error('rewrite rejected');
      },
    } as unknown as McpClientExtensionRegistry;
    const wrapped = installRegisteredExtensionDispatch(transport, registry);

    await expect(
      wrapped.send({ id: 1, jsonrpc: '2.0', method: 'tasks/get', params: {} })
    ).rejects.toThrow('rewrite rejected');
  });

  it('encodes only header values that cannot be sent literally', () => {
    expect(encodeMcpHeaderValue('task-123')).toBe('task-123');
    expect(encodeMcpHeaderValue('tâsk-雪')).toBe('=?base64?dMOic2st6Zuq?=');
    expect(encodeMcpHeaderValue('')).toBe('=?base64??=');
    expect(encodeMcpHeaderValue(' task-123')).toBe('=?base64?IHRhc2stMTIz?=');
  });

  it.each([undefined, 'not-json', new Uint8Array([1, 2, 3])])(
    'rejects an unreadable body carrying a registered extension method header',
    (body) => {
      expect(() =>
        applyRegisteredExtensionHttpHeaders(
          {
            body,
            headers: { 'mcp-method': TEST_EXTENSION_REQUEST.method },
            method: 'POST',
          },
          registeredRegistry()
        )
      ).toThrow(/registered MCP extension request body/iu);
    }
  );

  it('rejects a registered extension body whose method header is missing', () => {
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: TEST_EXTENSION_REQUEST.method,
            params: { taskId: 'task-123' },
          }),
          method: 'POST',
        },
        registeredRegistry()
      )
    ).toThrow('method/header mismatch');
  });

  it('accepts an agreeing Mcp-Name and rejects transport header drift', () => {
    const request = {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: TEST_EXTENSION_REQUEST.method,
        params: { taskId: 'task-123' },
      }),
      headers: {
        'mcp-method': TEST_EXTENSION_REQUEST.method,
        'mcp-name': 'task-123',
      },
      method: 'POST',
    };
    expect(
      new Headers(applyRegisteredExtensionHttpHeaders(request, registeredRegistry())?.headers).get(
        'mcp-name'
      )
    ).toBe('task-123');
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        { ...request, headers: { ...request.headers, 'mcp-name': 'different-task' } },
        registeredRegistry()
      )
    ).toThrow('Mcp-Name mismatch');
  });

  it('rejects an unexpected Mcp-Name when the contract declares no name parameter', () => {
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'tasks/update',
            params: { taskId: 'task-123' },
          }),
          headers: { 'mcp-method': 'tasks/update', 'mcp-name': 'task-123' },
          method: 'POST',
        },
        registryWithoutMcpName()
      )
    ).toThrow('unexpected Mcp-Name');
  });
});
