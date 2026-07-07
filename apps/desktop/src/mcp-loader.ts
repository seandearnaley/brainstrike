import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { app, safeStorage } from 'electron';
export type McpServer =
  | {
      transport: 'stdio';
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabledTools?: string[];
    }
  | {
      transport: 'sse';
      name: string;
      url: string;
      headers?: Record<string, string>;
      enabledTools?: string[];
    };
export interface McpConfig {
  servers: McpServer[];
}

const logger = createLogger('DesktopMcpLoader');

const DEFAULT_MCP_CONFIG_TEMPLATE = `{
  // BrainStrike MCP configuration (JSON with comments is supported).
  // Add server entries to the "servers" array below.
  "servers": [
    // Example: Local stdio server
    // {
    //   "transport": "stdio",
    //   "name": "filesystem",
    //   "command": "npx",
    //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/workspace"]
    // },

    // Example: Remote SSE server
    // {
    //   "transport": "sse",
    //   "name": "remote-api",
    //   "url": "https://your-host.example.com/mcp/sse",
    //   "headers": {
    //     "Authorization": "Bearer YOUR_TOKEN"
    //   }
    // }
  ]
}
`;

type CommentStripMode = 'normal' | 'string' | 'line-comment' | 'block-comment';

interface CommentStripState {
  escaped: boolean;
  mode: CommentStripMode;
}

function handleLineComment(char: string, output: string[], state: CommentStripState): void {
  if (char !== '\n') {
    return;
  }
  state.mode = 'normal';
  output.push(char);
}

function handleBlockComment(
  char: string,
  next: string | undefined,
  output: string[],
  state: CommentStripState
): number {
  if (char === '*' && next === '/') {
    state.mode = 'normal';
    return 1;
  }

  if (char === '\n') {
    output.push(char);
  }

  return 0;
}

function handleString(char: string, output: string[], state: CommentStripState): void {
  output.push(char);
  if (state.escaped) {
    state.escaped = false;
    return;
  }

  if (char === '\\') {
    state.escaped = true;
    return;
  }

  if (char === '"') {
    state.mode = 'normal';
  }
}

function handleNormal(
  char: string,
  next: string | undefined,
  output: string[],
  state: CommentStripState
): number {
  if (char === '"') {
    state.mode = 'string';
    output.push(char);
    return 0;
  }

  if (char === '/' && next === '/') {
    state.mode = 'line-comment';
    return 1;
  }

  if (char === '/' && next === '*') {
    state.mode = 'block-comment';
    return 1;
  }

  output.push(char);
  return 0;
}

function stripJsonComments(text: string): string {
  // Keep JSONC preprocessing local and dependency-free in desktop main.
  // Supported syntax mirrors our MCP template/editor needs: comments + trailing commas.
  // If this expands beyond MCP config editing, prefer a dedicated JSONC parser dependency.
  const output: string[] = [];
  const state: CommentStripState = { escaped: false, mode: 'normal' };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) {
      continue;
    }
    const next = text[index + 1];

    if (state.mode === 'line-comment') {
      handleLineComment(char, output, state);
      continue;
    }

    if (state.mode === 'block-comment') {
      index += handleBlockComment(char, next, output, state);
      continue;
    }

    if (state.mode === 'string') {
      handleString(char, output, state);
      continue;
    }

    index += handleNormal(char, next, output, state);
  }

  if (state.mode === 'block-comment') {
    throw new Error('invalid_mcp_config: unterminated block comment');
  }
  if (state.mode === 'string') {
    throw new Error('invalid_mcp_config: unterminated string');
  }

  return output.join('');
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function findNextNonWhitespaceCharacter(text: string, startIndex: number): string | undefined {
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (!isJsonWhitespace(char)) {
      return char;
    }
  }
  return;
}

interface TrailingCommaStripState {
  escaped: boolean;
  inString: boolean;
}

function consumeStringCharacter(
  char: string,
  output: string[],
  state: TrailingCommaStripState
): void {
  output.push(char);
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (char === '\\') {
    state.escaped = true;
    return;
  }
  if (char === '"') {
    state.inString = false;
  }
}

function isTrailingCommaToken(text: string, commaIndex: number): boolean {
  const nextNonWhitespace = findNextNonWhitespaceCharacter(text, commaIndex + 1);
  return nextNonWhitespace === '}' || nextNonWhitespace === ']';
}

function stripTrailingCommas(text: string): string {
  const output: string[] = [];
  const state: TrailingCommaStripState = {
    escaped: false,
    inString: false,
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) {
      continue;
    }

    if (state.inString) {
      consumeStringCharacter(char, output, state);
      continue;
    }

    if (char === '"') {
      state.inString = true;
      output.push(char);
      continue;
    }

    if (char === ',' && isTrailingCommaToken(text, index)) {
      continue;
    }

    output.push(char);
  }

  return output.join('');
}

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
    command: server['command'] as string,
    name: server['name'] as string,
    transport: 'stdio',
  };

  if (Array.isArray(server['args'])) {
    result.args = (server['args'] as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  if (server['env'] && typeof server['env'] === 'object') {
    result.env = server['env'] as Record<string, string>;
  }
  if (Array.isArray(server['enabledTools'])) {
    result.enabledTools = (server['enabledTools'] as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    );
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
    name: server['name'] as string,
    transport: 'sse',
    url: server['url'] as string,
  };

  if (server['headers'] && typeof server['headers'] === 'object') {
    result.headers = server['headers'] as Record<string, string>;
  }
  if (Array.isArray(server['enabledTools'])) {
    result.enabledTools = (server['enabledTools'] as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    );
  }

  return result;
}

export function parseMcpConfig(text: string): McpConfig {
  const jsoncText = stripJsonComments(text);
  const normalizedJson = stripTrailingCommas(jsoncText);
  let raw: unknown;
  try {
    raw = JSON.parse(normalizedJson);
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`invalid_mcp_config: ${parseMessage}`);
  }
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

  if (rawServers.length > 0 && servers.length === 0) {
    throw new Error('invalid_mcp_config: no valid servers');
  }

  return { servers };
}

export interface LoadedMcpConfig {
  config?: McpConfig;
  error?: string;
  exists: boolean;
  loadedAt?: number;
  path: string;
  servers?: McpServer[];
}

interface CustomConfigPathCache {
  initialized: boolean;
  value: string | null;
}

// Main-process singleton cache for the selected MCP config path.
// Electron main is single-threaded; this avoids repeated disk reads while keeping updates explicit.
const customConfigPathCache: CustomConfigPathCache = {
  initialized: false,
  value: null,
};

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
    if (!file) {
      return null;
    }
    const content = await fsp.readFile(file, 'utf-8');
    const trimmedPath = content.trim();
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
      try {
        await fsp.unlink(file);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') {
          throw err;
        }
      }
    }
  } catch (error) {
    logger.error('Failed to save custom MCP config path', { error });
  }
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

export async function setCustomMcpConfigPath(configPath: string | null): Promise<void> {
  const normalizedPath = normalizeCustomConfigPath(configPath);
  customConfigPathCache.value = normalizedPath;
  customConfigPathCache.initialized = true;
  await saveCustomConfigPath(normalizedPath);
}

export async function getMcpConfigPath(): Promise<string> {
  // Keep custom-path overrides sticky in memory, but re-check disk while
  // cache is empty so external/manual custom-path creation is still observed.
  if (!customConfigPathCache.initialized || customConfigPathCache.value === null) {
    customConfigPathCache.value = await loadCustomConfigPath();
    customConfigPathCache.initialized = true;
  }

  if (customConfigPathCache.value) {
    return customConfigPathCache.value;
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

export interface McpConfigTextDocument {
  content: string;
  created: boolean;
  exists: boolean;
  path: string;
}

async function ensureMcpConfigFile(createIfMissing: boolean): Promise<{
  path: string;
  exists: boolean;
  created: boolean;
}> {
  const configPath = await getMcpConfigPath();

  if (createIfMissing) {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    try {
      // Exclusive create avoids TOCTOU races between existence check and write.
      await fsp.writeFile(configPath, DEFAULT_MCP_CONFIG_TEMPLATE, {
        encoding: 'utf-8',
        flag: 'wx',
      });
      return { created: true, exists: true, path: configPath };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  try {
    await fsp.access(configPath);
    return { created: false, exists: true, path: configPath };
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      throw error;
    }
  }

  return { created: false, exists: false, path: configPath };
}

export async function readMcpConfigText(createIfMissing = false): Promise<McpConfigTextDocument> {
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
  return {
    content,
    created: ensured.created,
    exists: true,
    path: ensured.path,
  };
}

export async function writeMcpConfigText(
  content: string
): Promise<{ path: string; success: true } | { path: string; success: false; error: string }> {
  const configPath = await getMcpConfigPath();

  try {
    parseMcpConfig(content);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      path: configPath,
      success: false,
    };
  }

  try {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, content, 'utf-8');
    return { path: configPath, success: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      path: configPath,
      success: false,
    };
  }
}

export function getDefaultMcpConfigTemplate(): string {
  return DEFAULT_MCP_CONFIG_TEMPLATE;
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

/**
 * Decrypt encrypted values in a key-value record.
 * Keys ending with 'Encrypted' are decrypted and stored without the suffix.
 */
function applyDecryption(record?: Record<string, string>): Record<string, string> | undefined {
  if (!record) {
    return record;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.endsWith('Encrypted')) {
      const target = k.slice(0, -'Encrypted'.length);
      out[target] = decryptIfEncrypted(v);
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

export const applyDecryptionToHeaders = applyDecryption;
export const applyDecryptionToEnv = applyDecryption;

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
    return { config: dec, exists: true, loadedAt: Date.now(), path: p, servers: dec.servers };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ENOENT' || message.includes('no such file or directory')) {
      return { exists: false, path: p };
    }
    logger.error('Failed to load MCP config', { code, error: message, path: p });
    return { error: message, exists: true, path: p };
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
  await ensureMcpDirExists();
  const watchedFileName = path.basename(p);
  let timer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(path.dirname(p), async (_ev, filename) => {
    if (filename?.toString() !== watchedFileName) {
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
