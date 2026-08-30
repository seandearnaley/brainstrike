import { McpClientExtensionRegistry } from '../../mcp/client-extension-registry';

export const TEST_EXTENSION_ID = 'com.example/integration-host';
export const TEST_EXTENSION_SETTINGS = { mode: 'strict' } as const;

export function createDeferredTestExtension(): {
  register: () => void;
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
          parseSettings: () => TEST_EXTENSION_SETTINGS,
          version: '2026-08-29',
        },
        { implementation, settings: TEST_EXTENSION_SETTINGS, version: '2026-08-29' }
      ),
    registry,
  };
}
