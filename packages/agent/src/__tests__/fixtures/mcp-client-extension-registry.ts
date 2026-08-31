import { z } from 'zod';
import { McpClientExtensionRegistry } from '../../mcp/client-extension-registry';

export const TEST_EXTENSION_ID = 'com.example/integration-host';
export const TEST_EXTENSION_SETTINGS = { mode: 'strict' } as const;
export const TEST_EXTENSION_REQUEST = {
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

function parseSettings(value: unknown): typeof TEST_EXTENSION_SETTINGS {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('mode' in value) ||
    value.mode !== 'strict'
  ) {
    throw new Error('test extension settings must be exactly { mode: "strict" }');
  }
  return TEST_EXTENSION_SETTINGS;
}

export function createDeferredTestExtension(): {
  register: () => void;
  registerAnother: () => void;
  registry: McpClientExtensionRegistry;
} {
  const registry = new McpClientExtensionRegistry();
  const implementation = { ready: true } as const;
  return {
    register: () =>
      registry.register(
        {
          id: TEST_EXTENSION_ID,
          isCompleteImplementation: (value): value is typeof implementation =>
            value === implementation,
          isServerSettingsCompatible: (client, server) => client.mode === server.mode,
          parseServerSettings: parseSettings,
          parseSettings,
          requests: [TEST_EXTENSION_REQUEST],
          version: '2026-08-29',
        },
        { implementation, settings: TEST_EXTENSION_SETTINGS, version: '2026-08-29' }
      ),
    registerAnother: () =>
      registry.register(
        {
          id: 'com.example/late-host',
          isCompleteImplementation: (value): value is typeof implementation =>
            value === implementation,
          parseSettings,
          version: '2026-08-29',
        },
        { implementation, settings: TEST_EXTENSION_SETTINGS, version: '2026-08-29' }
      ),
    registry,
  };
}
