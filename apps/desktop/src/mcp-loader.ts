import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  McpConfigValidationError,
  type McpProtocolMigration,
  parseMcpConfigValue,
  parseMcpServerValue,
  type ResolvedMcpConfig,
  type ResolvedMcpServer,
  type McpConfigInput as SharedMcpConfigInput,
  type McpServerInput as SharedMcpServerInput,
} from '@brainstrike/assistant-contract/mcp-config';
import { createLogger } from '@brainstrike/logging';
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

export type McpServer = SharedMcpServerInput;
export type McpConfig = SharedMcpConfigInput;
export type { ResolvedMcpConfig, ResolvedMcpServer };

const logger = createLogger('DesktopMcpLoader');

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
    // The UUID references the encrypted desktop credential authority; the token
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

function withDesktopValidationMessage<T>(parse: () => T): T {
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

  return withDesktopValidationMessage(() => parseMcpConfigValue(getNodeValue(root)));
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
  error?: string;
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
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(record)) {
    if (k.endsWith('Encrypted')) {
      const target = k.slice(0, -'Encrypted'.length);
      out[target] = await decryptIfEncrypted(v, contextForKey(target));
    } else if (!Object.hasOwn(out, k)) {
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

function assertNoForbiddenDecryptedProperty(
  record: Record<string, string>,
  path: 'env' | 'headers'
): void {
  if (Object.hasOwn(record, '__proto__')) {
    throw new Error(
      `invalid_mcp_config: ${path}.__proto__: forbidden property "__proto__" after decryption`
    );
  }
}

async function processHttpServer(
  s: Extract<McpServer, { transport: 'sse' | 'streamable-http' }>
): Promise<ResolvedMcpServer> {
  const headers = await applyDecryptionToHeaders(s.headers, s.name);
  if (headers !== undefined) {
    assertNoForbiddenDecryptedProperty(headers, 'headers');
    return withDesktopValidationMessage(() => parseMcpServerValue({ ...s, headers }));
  }
  const { headers: _, ...rest } = s;
  return withDesktopValidationMessage(() => parseMcpServerValue(rest));
}

function unsupportedTransport(server: unknown): never {
  const details =
    typeof server === 'object' && server !== null
      ? (server as { name?: unknown; transport?: unknown })
      : {};
  const name = typeof details.name === 'string' ? details.name : '<unknown>';
  const transport =
    typeof details.transport === 'string' ? details.transport : String(details.transport);
  throw new Error(
    `invalid_mcp_config: MCP server "${name}" has unsupported transport "${transport}"`
  );
}

async function processStdioServer(
  s: Extract<McpServer, { transport: 'stdio' }>
): Promise<ResolvedMcpServer> {
  const env = await applyDecryptionToEnv(s.env, s.name);
  if (env !== undefined) {
    assertNoForbiddenDecryptedProperty(env, 'env');
    return withDesktopValidationMessage(() => parseMcpServerValue({ ...s, env }));
  }
  const { env: _, ...rest } = s;
  return withDesktopValidationMessage(() => parseMcpServerValue(rest));
}

export async function withDecryptedSecrets(cfg: McpConfig): Promise<ResolvedMcpConfig> {
  const servers = await Promise.all(
    cfg.servers.map(async (s): Promise<ResolvedMcpServer> => {
      if (s.transport === 'sse' || s.transport === 'streamable-http') {
        return processHttpServer(s);
      }
      if (s.transport === 'stdio') {
        return processStdioServer(s);
      }
      return unsupportedTransport(s);
    })
  );
  return { servers };
}

export async function loadMcpConfig(): Promise<LoadedMcpConfig> {
  const p = await getMcpConfigPath();
  try {
    const text = await fsp.readFile(p, 'utf-8');
    const parsed = parseMcpConfigDocument(text);
    const dec = await withDecryptedSecrets(parsed.config);
    if (parsed.migrations.length > 0) {
      logger.warn('MCP protocol policy omitted; using visible legacy migration', {
        migrations: parsed.migrations,
        path: p,
      });
    }
    return {
      config: dec,
      exists: true,
      loadedAt: Date.now(),
      migrations: parsed.migrations,
      path: p,
      servers: dec.servers,
    };
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
  onChange: (config: LoadedMcpConfig) => Promise<void> | void
): Promise<McpWatcher> {
  const p = await getMcpConfigPath();
  // ensure directory exists to avoid immediate watch errors
  await ensureMcpDirExists();
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
        config = await loadMcpConfig();
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
}
