import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpToolRegistry } from '@brainstrike/agent/mcp-client';
import type { McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import {
  type ConfiguredMcpServerId,
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  type McpHostControlRequest,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { vi } from 'vitest';
import {
  createMcpConfigFile,
  type LoadedMcpConfig,
  type McpConfigFile,
  type ResolvedMcpConfig,
} from '../src/mcp/config-file.js';
import { MCP_EXTENSION_PREFERENCES_SETTING } from '../src/mcp/extension-preferences.js';
import { McpSettingsAuthority } from '../src/mcp/settings-authority.js';

type ListToolsResult = Extract<McpHostOperationResult, { type: 'tools/list' }>['result'];
export type ListTools = (serverId: ConfiguredMcpServerId) => Promise<ListToolsResult>;

/** One tool per name, as a server's `tools/list` returns it. */
export function toolList(...names: string[]): ListToolsResult {
  return {
    tools: names.map((name) => ({ inputSchema: { type: 'object' as const }, name })),
  };
}

export function stdioServer(name: string): Record<string, unknown> {
  return { command: 'node', name, protocol: 'legacy', transport: 'stdio' };
}

/**
 * The in-process runtime the authority commits to: config replacement mints a
 * snapshot revision, `tools/list` answers from `listTools`, and lifecycle
 * controls answer the configured server's snapshot unless a test overrides it.
 */
function createRuntime(listTools: ListTools) {
  let current: McpHostSnapshot = { revision: 0, servers: [] };
  let extensions: McpExtensionEnablement = MCP_EXTENSIONS_ENABLED;
  const invoke = vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
    if (operation.type !== 'tools/list') {
      throw new Error('The settings test runtime only answers tools/list');
    }
    return { result: await listTools(operation.configuredServerId), type: 'tools/list' } as const;
  });
  const replaceResolvedConfig = vi.fn(async (config: ResolvedMcpConfig) => {
    current = {
      revision: current.revision + 1,
      servers: config.servers.map((server) => ({
        configuredProtocol: server.protocol,
        configuredServerId: parseConfiguredMcpServerId(server.name),
        generation: current.revision + 1,
        state:
          server.startup === 'authentication-required' ? 'authentication-required' : 'disconnected',
        transport: server.transport,
      })),
    };
    return current;
  });
  const control = vi.fn(async (request: McpHostControlRequest): Promise<McpHostServerSnapshot> => {
    const server = current.servers.find(
      ({ configuredServerId }) => configuredServerId === request.configuredServerId
    );
    if (!server) {
      throw new Error('Test MCP server is not configured');
    }
    return structuredClone(server);
  });
  const setMcpExtensionPreferences = vi.fn(async (next: McpExtensionEnablement) => {
    extensions = next;
    current = { ...current, revision: current.revision + 1 };
    return current;
  });
  return {
    control,
    invoke,
    replaceResolvedConfig,
    runtime: {
      host: { control, invoke },
      get mcpExtensionPreferences(): McpExtensionEnablement {
        return extensions;
      },
      replaceResolvedConfig,
      setMcpExtensionPreferences,
    },
    setMcpExtensionPreferences,
  };
}

/** The host's StateStore settings, in memory, with injectable failures. */
function createSettingsStore() {
  const values = new Map<string, string>();
  return {
    store: {
      deleteSetting: vi.fn(async (key: string) => values.delete(key)),
      getSetting: vi.fn(async (key: string) => values.get(key)),
      setSetting: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    },
    values,
  };
}

/**
 * A real profile directory and config file. The file watcher is the one seam:
 * a test fires a change deterministically instead of waiting on file events.
 */
export async function createSettingsHarness(options: { listTools?: ListTools } = {}) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'bs-mcp-settings-'));
  const listTools: ListTools = options.listTools ?? (async () => toolList());
  const fake = createRuntime(listTools);
  const settings = createSettingsStore();
  const realFile = createMcpConfigFile(userDataDir);
  const watchers: Array<{
    readonly onChange: (config: LoadedMcpConfig) => Promise<void> | void;
    readonly close: ReturnType<typeof vi.fn>;
  }> = [];
  const configFile: McpConfigFile = {
    ...realFile,
    watch: vi.fn(async (onChange) => {
      const watcher = { close: vi.fn(), onChange };
      watchers.push(watcher);
      return { close: watcher.close };
    }),
  };
  const authority = new McpSettingsAuthority({
    configFile,
    extensionStore: settings.store,
    runtime: fake.runtime,
    userDataDir,
  });
  const events: McpSettingsEvent[] = [];
  authority.subscribe((event) => events.push(event));
  const configPath = path.join(userDataDir, 'mcp', 'mcp.config.json');
  const preferencesPath = path.join(userDataDir, 'mcp', 'tool-preferences.json');
  return {
    authority,
    configFile,
    configPath,
    events,
    ...fake,
    /** The live watcher: the last one installed and not closed. */
    activeWatcher() {
      const live = watchers.filter(({ close }) => close.mock.calls.length === 0);
      return live.at(-1);
    },
    async cleanup() {
      mcpToolRegistry.clear();
      await rm(userDataDir, { force: true, recursive: true });
    },
    /** Fire the live watcher as a saved edit of the config file would. */
    async fireWatch() {
      const watcher = this.activeWatcher();
      if (!watcher) {
        throw new Error('No live MCP config watcher');
      }
      await watcher.onChange(await realFile.load());
    },
    preferencesPath,
    async readPreferences(): Promise<unknown> {
      return JSON.parse(await readFile(preferencesPath, 'utf8'));
    },
    settings,
    toolsEvents(): McpSettingsEvent[] {
      return events.filter(({ type }) => type === 'tools');
    },
    userDataDir,
    async writeConfig(servers: readonly Record<string, unknown>[]): Promise<void> {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ servers }), 'utf8');
    },
    async writePreferences(preferences: unknown): Promise<void> {
      await mkdir(path.dirname(preferencesPath), { recursive: true });
      await writeFile(
        preferencesPath,
        typeof preferences === 'string' ? preferences : JSON.stringify(preferences),
        'utf8'
      );
    },
    async writeStoredExtensions(value: unknown): Promise<void> {
      settings.values.set(MCP_EXTENSION_PREFERENCES_SETTING, JSON.stringify(value));
    },
  };
}

export type SettingsHarness = Awaited<ReturnType<typeof createSettingsHarness>>;

/** The tools the registry publishes, as `server.tool -> enabled`. */
export function enabledById(): Record<string, boolean> {
  return Object.fromEntries(
    Object.values(mcpToolRegistry.getAllTools())
      .flat()
      .map((tool) => [tool.id, tool.enabled])
  );
}
