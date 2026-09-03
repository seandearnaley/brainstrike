/**
 * Registered MCP extension off switch (BST-1604): the two dials, their
 * defaults, and the effective projection the desktop host connects with.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMcpExtensionPreferences,
  parseMcpConfigValue,
  type ResolvedMcpConfig,
} from '../mcp-config.js';
import {
  enabledMcpExtensionIds,
  hasNoEnabledMcpExtension,
  MCP_EXTENSION_ID_BY_KEY,
  MCP_EXTENSION_KEYS,
  MCP_EXTENSIONS_ENABLED,
  parseMcpExtensionEnablement,
  resolveMcpExtensionEnablement,
} from '../mcp-extensions.js';
import { MCP_SUPPORT_MATRIX } from '../mcp-status.js';

const stdio = (extensions?: unknown, name = 'local.tasks') => ({
  command: '/usr/local/bin/tasks',
  name,
  protocol: 'legacy' as const,
  transport: 'stdio' as const,
  ...(extensions === undefined ? {} : { extensions }),
});

describe('MCP extension enablement', () => {
  it('names exactly the support matrix extensions that are advertised', () => {
    const supported = MCP_SUPPORT_MATRIX.filter(
      ({ kind, status }) => kind === 'extension' && status === 'supported'
    ).map(({ id }) => id);
    expect(MCP_EXTENSION_KEYS.map((key) => MCP_EXTENSION_ID_BY_KEY[key])).toEqual(supported);
  });

  it('defaults every dial to enabled', () => {
    expect(MCP_EXTENSIONS_ENABLED).toEqual({ apps: true, tasks: true });
    expect(parseMcpExtensionEnablement({})).toEqual({ apps: true, tasks: true });
    expect(resolveMcpExtensionEnablement(undefined)).toEqual({ apps: true, tasks: true });
  });

  it('throws on a malformed preference instead of falling back to the default', () => {
    expect(() => parseMcpExtensionEnablement({ apps: 'yes' })).toThrow();
    expect(() => parseMcpExtensionEnablement({ unknown: true })).toThrow();
    expect(() => parseMcpExtensionEnablement(null)).toThrow();
  });

  it('turns an extension off when either dial is off', () => {
    expect(resolveMcpExtensionEnablement({ apps: false }, MCP_EXTENSIONS_ENABLED)).toEqual({
      apps: false,
      tasks: true,
    });
    expect(resolveMcpExtensionEnablement(undefined, { apps: true, tasks: false })).toEqual({
      apps: true,
      tasks: false,
    });
    expect(resolveMcpExtensionEnablement({ tasks: true }, { apps: false, tasks: false })).toEqual({
      apps: false,
      tasks: false,
    });
  });

  it('projects the advertised ids and the empty case', () => {
    expect(enabledMcpExtensionIds({ apps: true, tasks: false })).toEqual([
      'io.modelcontextprotocol/ui',
    ]);
    expect(hasNoEnabledMcpExtension({ apps: false, tasks: false })).toBe(true);
    expect(hasNoEnabledMcpExtension({ apps: false, tasks: true })).toBe(false);
  });
});

describe('per-server extension overrides in the config document', () => {
  it('omits the field entirely when the document does not set it', () => {
    const { config } = parseMcpConfigValue({ servers: [stdio()] });
    expect(config.servers[0]).not.toHaveProperty('extensions');
  });

  it('normalizes a partial override to both booleans', () => {
    const { config } = parseMcpConfigValue({ servers: [stdio({ tasks: false })] });
    expect(config.servers[0]?.extensions).toEqual({ apps: true, tasks: false });
  });

  it('rejects an unknown or malformed extension key', () => {
    expect(() => parseMcpConfigValue({ servers: [stdio({ ui: false })] })).toThrow();
    expect(() => parseMcpConfigValue({ servers: [stdio({ apps: 'off' })] })).toThrow();
  });
});

describe('applyMcpExtensionPreferences', () => {
  const config = (): ResolvedMcpConfig =>
    parseMcpConfigValue({ servers: [stdio(), stdio({ apps: false }, 'local.other')] }).config;

  it('folds the global preference into every server as the effective state', () => {
    const applied = applyMcpExtensionPreferences(config(), { apps: true, tasks: false });
    expect(applied.servers.map(({ extensions }) => extensions)).toEqual([
      { apps: true, tasks: false },
      { apps: false, tasks: false },
    ]);
  });

  it('is stable for an unchanged preference so a reload does not churn the definition', () => {
    const first = applyMcpExtensionPreferences(config(), MCP_EXTENSIONS_ENABLED);
    const second = applyMcpExtensionPreferences(config(), MCP_EXTENSIONS_ENABLED);
    expect(first).toEqual(second);
  });
});
