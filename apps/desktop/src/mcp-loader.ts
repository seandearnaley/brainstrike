import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { app, safeStorage } from 'electron';
import {
  getLocation,
  getNodePath,
  getNodeValue,
  type Node as JsoncNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { z } from 'zod';

const NonEmptyStringSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => value.trim().length > 0, 'must not be blank');
const StringRecordSchema = z.record(z.string(), z.string());
const HeadersSchema = StringRecordSchema.superRefine((headers, context) => {
  for (const [name, value] of Object.entries(headers)) {
    try {
      new Headers([[name, '']]);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'invalid HTTP header name',
        path: [name],
      });
      continue;
    }

    try {
      new Headers([[name, value]]);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'invalid HTTP header value',
        path: [name],
      });
    }
  }
});

const StdioServerSchema = z.strictObject({
  args: z.array(z.string()).optional(),
  command: NonEmptyStringSchema,
  enabledTools: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  name: NonEmptyStringSchema,
  transport: z.literal('stdio'),
});

const SseServerSchema = z.strictObject({
  enabledTools: z.array(z.string()).optional(),
  headers: HeadersSchema.optional(),
  name: NonEmptyStringSchema,
  transport: z.literal('sse'),
  url: z.url({ protocol: /^https?$/u }),
});

const McpServerSchema = z.discriminatedUnion('transport', [StdioServerSchema, SseServerSchema]);
const McpConfigSchema = z
  .strictObject({
    servers: z.array(McpServerSchema),
  })
  .superRefine((config, context) => {
    const serverNames = new Set<string>();
    for (const [index, server] of config.servers.entries()) {
      if (serverNames.has(server.name)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate server name',
          path: ['servers', index, 'name'],
        });
        continue;
      }
      serverNames.add(server.name);
    }
  });

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

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

interface DuplicateProperty {
  key: string;
  offset: number;
  path: (number | string)[];
}

function collectDuplicateProperties(node: JsoncNode, duplicates: DuplicateProperty[]): void {
  if (node.type === 'array') {
    for (const child of node.children ?? []) {
      collectDuplicateProperties(child, duplicates);
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

    if (propertyNames.has(keyNode.value)) {
      duplicates.push({
        key: keyNode.value,
        offset: keyNode.offset,
        path: getNodePath(keyNode),
      });
    } else {
      propertyNames.add(keyNode.value);
    }

    if (valueNode) {
      collectDuplicateProperties(valueNode, duplicates);
    }
  }
}

function formatDuplicateProperty(text: string, duplicate: DuplicateProperty): string {
  const { column, line } = getLineAndColumn(text, duplicate.offset);
  return `duplicate property ${JSON.stringify(duplicate.key)} at line ${line}, column ${column} (${duplicate.path.join('.')})`;
}

function formatValidationIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

export function parseMcpConfig(text: string): McpConfig {
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

  const duplicateProperties: DuplicateProperty[] = [];
  collectDuplicateProperties(root, duplicateProperties);
  if (duplicateProperties.length > 0) {
    throw new Error(
      `invalid_mcp_config: ${duplicateProperties
        .map((duplicate) => formatDuplicateProperty(text, duplicate))
        .join('; ')}`
    );
  }

  const raw = getNodeValue(root) as unknown;
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid_mcp_config: ${parsed.error.issues.map(formatValidationIssue).join('; ')}`
    );
  }

  return parsed.data;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeEncryptedValue(value: string, context: string): Buffer {
  const encrypted = Buffer.from(value, 'base64');
  if (encrypted.byteLength === 0 || encrypted.toString('base64') !== value) {
    throw new Error(`${context}: ciphertext must be non-empty canonical base64`);
  }
  return encrypted;
}

export async function decryptIfEncrypted(
  value: string,
  context = 'MCP encrypted value'
): Promise<string> {
  const encrypted = decodeEncryptedValue(value, context);

  if (
    typeof safeStorage?.isAsyncEncryptionAvailable !== 'function' ||
    typeof safeStorage.decryptStringAsync !== 'function'
  ) {
    throw new Error(`${context}: asynchronous safeStorage API is unavailable`);
  }

  let encryptionAvailable: boolean;
  try {
    encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
  } catch (error) {
    throw new Error(`${context}: failed to check safeStorage availability: ${errorMessage(error)}`);
  }

  if (!encryptionAvailable) {
    throw new Error(`${context}: safeStorage encryption is unavailable`);
  }

  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    let selectedBackend: ReturnType<typeof safeStorage.getSelectedStorageBackend>;
    try {
      selectedBackend = safeStorage.getSelectedStorageBackend();
    } catch (error) {
      throw new Error(`${context}: failed to inspect safeStorage backend: ${errorMessage(error)}`);
    }
    if (selectedBackend === 'basic_text') {
      throw new Error(`${context}: safeStorage backend basic_text is insecure`);
    }
  }

  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    if (shouldReEncrypt) {
      logger.warn('MCP secret should be re-encrypted with the current safeStorage key', {
        context,
      });
    }
    return result;
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

/**
 * Decrypt encrypted values in a key-value record.
 * Keys ending with 'Encrypted' are decrypted and stored without the suffix.
 */
async function applyDecryption(
  record: Record<string, string> | undefined,
  contextForKey: (key: string) => string
): Promise<Record<string, string> | undefined> {
  if (!record) {
    return record;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.endsWith('Encrypted')) {
      const target = k.slice(0, -'Encrypted'.length);
      out[target] = await decryptIfEncrypted(v, contextForKey(target));
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

export function applyDecryptionToHeaders(
  headers?: Record<string, string>,
  serverName?: string
): Promise<Record<string, string> | undefined> {
  return applyDecryption(headers, (key) =>
    serverName ? `MCP server "${serverName}" header "${key}"` : `MCP header "${key}"`
  );
}

export function applyDecryptionToEnv(
  env?: Record<string, string>,
  serverName?: string
): Promise<Record<string, string> | undefined> {
  return applyDecryption(env, (key) =>
    serverName
      ? `MCP server "${serverName}" environment variable "${key}"`
      : `MCP environment variable "${key}"`
  );
}

async function processSseServer(s: Extract<McpServer, { transport: 'sse' }>): Promise<McpServer> {
  const headers = await applyDecryptionToHeaders(s.headers, s.name);
  if (headers !== undefined) {
    return { ...s, headers };
  }
  const { headers: _, ...rest } = s;
  return rest;
}

async function processStdioServer(
  s: Extract<McpServer, { transport: 'stdio' }>
): Promise<McpServer> {
  const env = await applyDecryptionToEnv(s.env, s.name);
  if (env !== undefined) {
    return { ...s, env };
  }
  const { env: _, ...rest } = s;
  return rest;
}

export async function withDecryptedSecrets(cfg: McpConfig): Promise<McpConfig> {
  const servers = await Promise.all(
    cfg.servers.map(async (s: McpServer): Promise<McpServer> => {
      if (s.transport === 'sse') {
        return processSseServer(s);
      }
      if (s.transport === 'stdio') {
        return processStdioServer(s);
      }
      return s;
    })
  );
  return { servers };
}

export async function loadMcpConfig(): Promise<LoadedMcpConfig> {
  const p = await getMcpConfigPath();
  try {
    const text = await fsp.readFile(p, 'utf-8');
    const cfg = parseMcpConfig(text);
    const dec = await withDecryptedSecrets(cfg);
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
