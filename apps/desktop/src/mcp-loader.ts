import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app, safeStorage } from 'electron';
export type McpServer =
  | {
      transport: 'stdio';
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { transport: 'sse'; name: string; url: string; headers?: Record<string, string> };
export interface McpConfig {
  servers: McpServer[];
}

const logger = createLogger('DesktopMcpLoader');

function parseStdioServer(s: unknown): McpServer | null {
  if (!s || typeof s !== 'object' || !('transport' in s)) {
    return null;
  }
  const server = s as Record<string, unknown>;

  if (
    server['transport'] !== 'stdio' ||
    typeof server['name'] !== 'string' ||
    typeof server['command'] !== 'string'
  ) {
    return null;
  }

  const result: McpServer = {
    transport: 'stdio',
    name: server['name'] as string,
    command: server['command'] as string,
  };

  if (Array.isArray(server['args'])) {
    result.args = (server['args'] as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  if (server['env'] && typeof server['env'] === 'object') {
    result.env = server['env'] as Record<string, string>;
  }

  return result;
}

function parseSseServer(s: unknown): McpServer | null {
  if (!s || typeof s !== 'object' || !('transport' in s)) {
    return null;
  }
  const server = s as Record<string, unknown>;

  if (
    server['transport'] !== 'sse' ||
    typeof server['name'] !== 'string' ||
    typeof server['url'] !== 'string'
  ) {
    return null;
  }

  const result: McpServer = {
    transport: 'sse',
    name: server['name'] as string,
    url: server['url'] as string,
  };

  if (server['headers'] && typeof server['headers'] === 'object') {
    result.headers = server['headers'] as Record<string, string>;
  }

  return result;
}

export function parseMcpConfig(text: string): McpConfig {
  const raw = JSON.parse(text) as unknown;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('servers' in raw) ||
    !Array.isArray((raw as { servers: unknown }).servers)
  ) {
    throw new Error('invalid_mcp_config: servers must be array');
  }

  const servers: McpServer[] = [];
  const rawServers = (raw as { servers: unknown[] }).servers;

  for (const s of rawServers) {
    const stdioServer = parseStdioServer(s);
    if (stdioServer) {
      servers.push(stdioServer);
      continue;
    }

    const sseServer = parseSseServer(s);
    if (sseServer) {
      servers.push(sseServer);
    }
  }

  if (servers.length === 0) {
    throw new Error('invalid_mcp_config: no valid servers');
  }
  return { servers };
}

export interface LoadedMcpConfig {
  path: string;
  exists: boolean;
  config?: McpConfig;
  servers?: McpServer[];
  loadedAt?: number;
}

let customConfigPath: string | null = null;

const CUSTOM_CONFIG_PATH_FILE = 'mcp-custom-path.txt';

function getCustomPathStorageFile(): string | null {
  const userData = app.getPath('userData');
  if (!userData) {
    return null;
  }
  return path.join(userData, 'mcp', CUSTOM_CONFIG_PATH_FILE);
}

async function loadCustomConfigPath(): Promise<string | null> {
  try {
    const file = getCustomPathStorageFile();
    if (file && fs.existsSync(file)) {
      const content = await fsp.readFile(file, 'utf-8');
      return content.trim() || null;
    }
  } catch (error) {
    logger.error('Failed to load custom MCP config path', { error });
  }
  return null;
}

async function saveCustomConfigPath(configPath: string | null): Promise<void> {
  try {
    const file = getCustomPathStorageFile();
    if (!file) {
      return; // Skip if userData is not available (e.g., in tests)
    }

    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (configPath) {
      await fsp.writeFile(file, configPath, 'utf-8');
    } else {
      // Delete the file if path is null
      try {
        await fsp.unlink(file);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    logger.error('Failed to save custom MCP config path', { error });
  }
}

export async function setCustomMcpConfigPath(configPath: string | null): Promise<void> {
  customConfigPath = configPath;
  await saveCustomConfigPath(configPath);
}

export async function getMcpConfigPath(): Promise<string> {
  // Load from disk if not already in memory
  if (!customConfigPath) {
    customConfigPath = await loadCustomConfigPath();
  }

  if (customConfigPath) {
    return customConfigPath;
  }
  const userData = app.getPath('userData');
  if (!userData) {
    // Fallback for tests or when userData is unavailable
    return '/mock/path/mcp/mcp.config.json';
  }
  const dir = path.join(userData, 'mcp');
  return path.join(dir, 'mcp.config.json');
}

export async function ensureMcpDirExists(): Promise<void> {
  const dir = path.dirname(await getMcpConfigPath());
  await fsp.mkdir(dir, { recursive: true });
}

export function decryptIfEncrypted(value: string): string {
  try {
    const buf = Buffer.from(value, 'base64');
    if (safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(buf);
    }
    // Test/dev fallback: treat as plain base64
    return buf.toString('utf-8');
  } catch {
    return value; // fallback to raw if not decryptable
  }
}

export function applyDecryptionToHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) {
    return headers;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.endsWith('Encrypted')) {
      const target = k.slice(0, -'Encrypted'.length);
      out[target] = decryptIfEncrypted(v);
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

export function applyDecryptionToEnv(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env) {
    return env;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.endsWith('Encrypted')) {
      const target = k.slice(0, -'Encrypted'.length);
      out[target] = decryptIfEncrypted(v);
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

function processSseServer(s: Extract<McpServer, { transport: 'sse' }>): McpServer {
  const headers = applyDecryptionToHeaders(s.headers);
  if (headers !== undefined) {
    return { ...s, headers };
  }
  const { headers: _, ...rest } = s;
  return rest;
}

function processStdioServer(s: Extract<McpServer, { transport: 'stdio' }>): McpServer {
  const env = applyDecryptionToEnv(s.env);
  if (env !== undefined) {
    return { ...s, env };
  }
  const { env: _, ...rest } = s;
  return rest;
}

export function withDecryptedSecrets(cfg: McpConfig): McpConfig {
  const servers: McpServer[] = cfg.servers.map((s: McpServer) => {
    if (s.transport === 'sse') {
      return processSseServer(s);
    }
    if (s.transport === 'stdio') {
      return processStdioServer(s);
    }
    return s;
  });
  return { servers };
}

export async function loadMcpConfig(): Promise<LoadedMcpConfig> {
  const p = await getMcpConfigPath();
  try {
    const text = await fsp.readFile(p, 'utf-8');
    const cfg = parseMcpConfig(text);
    const dec = withDecryptedSecrets(cfg);
    return { path: p, exists: true, config: dec, servers: dec.servers, loadedAt: Date.now() };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    if (error && (error.code === 'ENOENT' || /no such file/i.test(String(error.message)))) {
      return { path: p, exists: false };
    }
    return { path: p, exists: false };
  }
}

export interface McpWatcher {
  close: () => void;
}

export async function watchMcpConfig(
  onChange: (config: LoadedMcpConfig) => void
): Promise<McpWatcher> {
  const p = await getMcpConfigPath();
  // ensure directory exists to avoid immediate watch errors
  void ensureMcpDirExists();
  let timer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(path.dirname(p), async (_ev, filename) => {
    if (!filename?.toString().includes('mcp.config.json')) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      onChange(await loadMcpConfig());
    }, 100);
  });
  return { close: () => watcher.close() };
}
