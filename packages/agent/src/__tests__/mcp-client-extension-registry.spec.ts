import { MCP_SUPPORT_MATRIX } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
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

function registerUntrusted(registry: McpClientExtensionRegistry, registration: unknown): void {
  Reflect.apply(registry.register, registry, [EXAMPLE_CONTRACT, registration]);
}

describe('McpClientExtensionRegistry', () => {
  it('advertises no extensions by default', () => {
    const capabilities = new McpClientExtensionRegistry().toClientExtensionCapabilities();
    const supportedProductIds = MCP_SUPPORT_MATRIX.filter(
      ({ kind, status }) => kind === 'extension' && status === 'supported'
    ).map(({ id }) => id);
    expect(capabilities).toBeUndefined();
    expect(supportedProductIds).toEqual(Object.keys(capabilities ?? {}));
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
