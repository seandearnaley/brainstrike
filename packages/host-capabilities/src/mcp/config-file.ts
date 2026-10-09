import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  McpConfigValidationError,
  type McpProtocolMigration,
  parseMcpConfigValue,
  type ResolvedMcpConfig,
  type ResolvedMcpServer,
  type McpConfigInput as SharedMcpConfigInput,
  type McpServerInput as SharedMcpServerInput,
} from '@brainstrike/assistant-contract/mcp-config';
import { createLogger } from '@brainstrike/logging';
import {
  getLocation,
  getNodePath,
  getNodeValue,
  type Node as JsoncNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';

export type McpServer = SharedMcpServerInput;
export type McpConfig = SharedMcpConfigInput;
export type { ResolvedMcpConfig, ResolvedMcpServer };

const logger = createLogger('McpConfigFile');

const DEFAULT_MCP_CONFIG_TEMPLATE = `{
  // BrainStrike MCP configuration (JSON with comments is supported).
  // Add server entries to the "servers" array below.
  "servers": [
    // Example: Local stdio server
    // {
    //   "transport": "stdio",
    //   "name": "filesystem",
    //   "protocol": "legacy",
    //   "command": "npx",
    //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/workspace"]
    // },

    // Optional per-server opt-out for the registered MCP extensions. Both ship
    // ON; either key may be omitted. Turning one off here stops THIS server
    // from being told the client supports it, without changing any other
    // server. The Settings switch is the global equivalent.
    // {
    //   "transport": "stdio",
    //   "name": "no-apps-no-tasks",
    //   "protocol": "2026-07-28",
    //   "command": "/absolute/path/to/server",
    //   "extensions": { "apps": false, "tasks": false }
    // },

    // Native Linear OAuth (hard read-only endpoint; safest default).
    // {
    //   "transport": "streamable-http",
    //   "name": "linear-readonly",
    //   "protocol": "auto",
    //   "url": "https://mcp.linear.app/mcp/readonly",
    //   "auth": { "type": "oauth-user" }
    // },

    // Native Linear OAuth (read-only token on the standard endpoint).
    // {
    //   "transport": "streamable-http",
    //   "name": "linear-read-scope",
    //   "protocol": "auto",
    //   "url": "https://mcp.linear.app/mcp",
    //   "auth": { "type": "oauth-user", "scopes": ["read"] }
    // },

    // Native Linear OAuth (read-write; opt in deliberately).
    // {
    //   "transport": "streamable-http",
    //   "name": "linear",
    //   "protocol": "auto",
    //   "url": "https://mcp.linear.app/mcp",
    //   "auth": { "type": "oauth-user" }
    // },

    // Example: Remote Streamable HTTP server with an external bearer credential.
    // The UUID references the agent host's profile credential store; the token
    // itself never belongs in this JSONC file.
    // {
    //   "transport": "streamable-http",
    //   "name": "remote-api",
    //   "protocol": "legacy",
    //   "url": "https://your-host.example.com/mcp",
    //   "auth": {
    //     "type": "bearer",
    //     "credential": {
    //       "store": "mcp-credentials",
    //       "id": "00000000-0000-4000-8000-000000000000"
    //     }
    //   }
    // },

    // Example: Legacy remote SSE server using the same secure reference form.
    // {
    //   "transport": "sse",
    //   "name": "legacy-remote-api",
    //   "protocol": "legacy",
    //   "url": "https://your-host.example.com/mcp/sse",
    //   "auth": {
    //     "type": "bearer",
    //     "credential": {
    //       "store": "mcp-credentials",
    //       "id": "00000000-0000-4000-8000-000000000000"
    //     }
    //   }
    // }
  ]
}
`;

function getLineAndColumn(text: string, offset: number): { column: number; line: number } {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/u);
  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
  };
}

function formatJsoncError(text: string, error: ParseError): string {
  const { column, line } = getLineAndColumn(text, error.offset);
  const path = getLocation(text, error.offset).path.join('.');
  const location = path ? ` (${path})` : '';
  return `${printParseErrorCode(error.error)} at line ${line}, column ${column}${location}`;
}

interface PropertyIssue {
  key: string;
  kind: 'duplicate' | 'forbidden';
  offset: number;
  path: (number | string)[];
}

function collectPropertyIssues(node: JsoncNode, issues: PropertyIssue[]): void {
  if (node.type === 'array') {
    for (const child of node.children ?? []) {
      collectPropertyIssues(child, issues);
    }
    return;
  }

  if (node.type !== 'object') {
    return;
  }

  const propertyNames = new Set<string>();
  for (const propertyNode of node.children ?? []) {
    const [keyNode, valueNode] = propertyNode.children ?? [];
    if (keyNode?.type !== 'string' || typeof keyNode.value !== 'string') {
      continue;
    }

    if (keyNode.value === '__proto__') {
      issues.push({
        key: keyNode.value,
        kind: 'forbidden',
        offset: keyNode.offset,
        path: getNodePath(keyNode),
      });
    }

    if (propertyNames.has(keyNode.value)) {
      issues.push({
        key: keyNode.value,
        kind: 'duplicate',
        offset: keyNode.offset,
        path: getNodePath(keyNode),
      });
    } else {
      propertyNames.add(keyNode.value);
    }

    if (valueNode) {
      collectPropertyIssues(valueNode, issues);
    }
  }
}

function formatPropertyIssue(text: string, issue: PropertyIssue): string {
  const { column, line } = getLineAndColumn(text, issue.offset);
  return `${issue.kind} property ${JSON.stringify(issue.key)} at line ${line}, column ${column} (${issue.path.join('.')})`;
}

function withConfigValidationMessage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof McpConfigValidationError)) {
      throw error;
    }
    throw new Error(
      `invalid_mcp_config: ${error.issues.map(({ message, path }) => `${path || '<root>'}: ${message}`).join('; ')}`
    );
  }
}

/**
 * Header and env keys ending in `Encrypted` held Electron safeStorage ciphertext,
 * which the agent host cannot read. They are refused visibly, never sent as a
 * literal value; a secret belongs in a bearer credential reference.
 */
function refuseEncryptedValues(config: ResolvedMcpConfig): void {
  for (const server of config.servers) {
    const values = server.transport === 'stdio' ? server.env : server.headers;
    const encrypted = Object.keys(values ?? {}).find((key) => key.endsWith('Encrypted'));
    if (encrypted) {
      throw new Error(
        `invalid_mcp_config: MCP server "${server.name}" value "${encrypted}" holds an Electron safeStorage secret, which the agent host does not read; use a bearer credential reference`
      );
    }
  }
}

function parseMcpConfigDocument(text: string): {
  config: ResolvedMcpConfig;
  migrations: McpProtocolMigration[];
} {
  const parseErrors: ParseError[] = [];
  const root = parseTree(text, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (parseErrors.length > 0) {
    throw new Error(
      `invalid_mcp_config: ${parseErrors.map((error) => formatJsoncError(text, error)).join('; ')}`
    );
  }

  if (!root) {
    throw new Error('invalid_mcp_config: configuration document is empty');
  }

  const propertyIssues: PropertyIssue[] = [];
  collectPropertyIssues(root, propertyIssues);
  if (propertyIssues.length > 0) {
    throw new Error(
      `invalid_mcp_config: ${propertyIssues
        .map((issue) => formatPropertyIssue(text, issue))
        .join('; ')}`
    );
  }

  const parsed = withConfigValidationMessage(() => parseMcpConfigValue(getNodeValue(root)));
  refuseEncryptedValues(parsed.config);
  return parsed;
}

export function parseMcpConfig(text: string): ResolvedMcpConfig {
  return parseMcpConfigDocument(text).config;
}

export interface LoadedMcpConfig {
  config?: ResolvedMcpConfig;
  error?: string;
  exists: boolean;
  loadedAt?: number;
  migrations?: McpProtocolMigration[];
  path: string;
  servers?: ResolvedMcpServer[];
}

export interface McpConfigTextDocument {
  content: string;
  created: boolean;
  error?: string;
  exists: boolean;
  path: string;
}

export type McpConfigWriteResult =
  | { path: string; success: true }
  | { error: string; path: string; success: false };

export interface McpWatcher {
  close: () => void;
}

/** One profile's MCP config file: its selected path, text, sample and watcher. */
export interface McpConfigFile {
  /** Exclusive create of the commented template; `created: false` when a file already exists. */
  createSample(): Promise<{ created: boolean; path: string }>;
  load(): Promise<LoadedMcpConfig>;
  /** The custom path when one is selected, else `<userData>/mcp/mcp.config.json`. */
  path(): Promise<string>;
  readText(createIfMissing?: boolean): Promise<McpConfigTextDocument>;
  setCustomPath(configPath: string | null): Promise<void>;
  watch(onChange: (config: LoadedMcpConfig) => Promise<void> | void): Promise<McpWatcher>;
  writeText(content: string): Promise<McpConfigWriteResult>;
}

export function getDefaultMcpConfigTemplate(): string {
  return DEFAULT_MCP_CONFIG_TEMPLATE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCustomConfigPath(configPath: string | null): string | null {
  if (configPath === null) {
    return null;
  }

  const trimmedPath = configPath.trim();
  if (trimmedPath.length === 0) {
    return null;
  }

  if (!path.isAbsolute(trimmedPath)) {
    throw new Error('invalid_mcp_config_path: path must be absolute');
  }

  return trimmedPath;
}

const CUSTOM_CONFIG_PATH_FILE = 'mcp-custom-path.txt';

/**
 * The MCP config file of the profile rooted at `userDataDir`. Its selected
 * custom path is cached in this instance and re-read from disk while unset,
 * so a custom path created outside the app is still observed.
 */
export function createMcpConfigFile(userDataDir: string): McpConfigFile {
  if (!path.isAbsolute(userDataDir)) {
    throw new TypeError('The MCP config file requires an absolute profile directory.');
  }
  const customPathFile = path.join(userDataDir, 'mcp', CUSTOM_CONFIG_PATH_FILE);
  const cache: { initialized: boolean; value: string | null } = {
    initialized: false,
    value: null,
  };

  const loadCustomConfigPath = async (): Promise<string | null> => {
    try {
      const trimmedPath = (await fsp.readFile(customPathFile, 'utf-8')).trim();
      if (trimmedPath.length === 0) {
        return null;
      }
      if (!path.isAbsolute(trimmedPath)) {
        logger.warn('Ignoring invalid custom MCP config path from storage', {
          path: trimmedPath,
        });
        return null;
      }
      return trimmedPath;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      logger.error('Failed to load custom MCP config path', { error });
    }
    return null;
  };

  const saveCustomConfigPath = async (configPath: string | null): Promise<void> => {
    try {
      await fsp.mkdir(path.dirname(customPathFile), { recursive: true });
      if (configPath) {
        await fsp.writeFile(customPathFile, configPath, 'utf-8');
      } else {
        try {
          await fsp.unlink(customPathFile);
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') {
            throw err;
          }
        }
      }
    } catch (error) {
      logger.error('Failed to save custom MCP config path', { error });
    }
  };

  const configPath = async (): Promise<string> => {
    // Keep custom-path overrides sticky in memory, but re-check disk while
    // cache is empty so external/manual custom-path creation is still observed.
    if (!cache.initialized || cache.value === null) {
      cache.value = await loadCustomConfigPath();
      cache.initialized = true;
    }
    return cache.value ?? path.join(userDataDir, 'mcp', 'mcp.config.json');
  };

  const ensureMcpConfigFile = async (
    createIfMissing: boolean
  ): Promise<{ path: string; exists: boolean; created: boolean }> => {
    const target = await configPath();

    if (createIfMissing) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      try {
        // Exclusive create avoids TOCTOU races between existence check and write.
        await fsp.writeFile(target, DEFAULT_MCP_CONFIG_TEMPLATE, {
          encoding: 'utf-8',
          flag: 'wx',
        });
        return { created: true, exists: true, path: target };
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') {
          throw error;
        }
      }
    }

    try {
      await fsp.access(target);
      return { created: false, exists: true, path: target };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }

    return { created: false, exists: false, path: target };
  };

  const load = async (): Promise<LoadedMcpConfig> => {
    const p = await configPath();
    try {
      const text = await fsp.readFile(p, 'utf-8');
      const parsed = parseMcpConfigDocument(text);
      if (parsed.migrations.length > 0) {
        logger.warn('MCP protocol policy omitted; using visible legacy migration', {
          migrations: parsed.migrations,
          path: p,
        });
      }
      return {
        config: parsed.config,
        exists: true,
        loadedAt: Date.now(),
        migrations: parsed.migrations,
        path: p,
        servers: parsed.config.servers,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = errorMessage(error);
      if (code === 'ENOENT' || message.includes('no such file or directory')) {
        return { exists: false, path: p };
      }
      logger.error('Failed to load MCP config', { code, error: message, path: p });
      return { error: message, exists: true, path: p };
    }
  };

  return {
    async createSample() {
      const target = await configPath();
      await fsp.mkdir(path.dirname(target), { recursive: true });
      try {
        // Write the commented template without active placeholder servers.
        // Exclusive create avoids TOCTOU races with concurrent writers.
        await fsp.writeFile(target, DEFAULT_MCP_CONFIG_TEMPLATE, {
          encoding: 'utf-8',
          flag: 'wx',
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EEXIST') {
          return { created: false, path: target };
        }
        throw error;
      }
      return { created: true, path: target };
    },
    load,
    path: configPath,
    async readText(createIfMissing = false) {
      const ensured = await ensureMcpConfigFile(createIfMissing);
      if (!ensured.exists) {
        return {
          content: '',
          created: false,
          exists: false,
          path: ensured.path,
        };
      }

      const content = await fsp.readFile(ensured.path, 'utf-8');
      let validationError: string | undefined;
      try {
        parseMcpConfig(content);
      } catch (error) {
        validationError = errorMessage(error);
      }
      return {
        content,
        created: ensured.created,
        ...(validationError === undefined ? {} : { error: validationError }),
        exists: true,
        path: ensured.path,
      };
    },
    async setCustomPath(next) {
      const normalizedPath = normalizeCustomConfigPath(next);
      cache.value = normalizedPath;
      cache.initialized = true;
      await saveCustomConfigPath(normalizedPath);
    },
    async watch(onChange) {
      const p = await configPath();
      // Ensure the directory exists to avoid immediate watch errors.
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const watchedFileName = path.basename(p);
      let timer: NodeJS.Timeout | null = null;
      let changeEpoch = 0;
      let closed = false;
      let callbackTail = Promise.resolve();
      const watcher = fs.watch(path.dirname(p), async (_ev, filename) => {
        if (filename?.toString() !== watchedFileName) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        const eventEpoch = ++changeEpoch;
        timer = setTimeout(async () => {
          let config: LoadedMcpConfig;
          try {
            config = await load();
          } catch (error) {
            logger.error('MCP config watcher reload failed', { error });
            return;
          }
          if (closed || eventEpoch !== changeEpoch) {
            return;
          }
          const callback = callbackTail.then(async () => {
            if (closed || eventEpoch !== changeEpoch) {
              return;
            }
            await onChange(config);
          });
          callbackTail = callback.catch(() => undefined);
          try {
            await callback;
          } catch (error) {
            logger.error('MCP config watcher callback failed', { error });
          }
        }, 100);
      });
      return {
        close: () => {
          closed = true;
          changeEpoch += 1;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          watcher.close();
        },
      };
    },
    async writeText(content) {
      const target = await configPath();

      try {
        parseMcpConfig(content);
      } catch (error) {
        return { error: errorMessage(error), path: target, success: false };
      }

      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, 'utf-8');
        return { path: target, success: true };
      } catch (error) {
        return { error: errorMessage(error), path: target, success: false };
      }
    },
  };
}
