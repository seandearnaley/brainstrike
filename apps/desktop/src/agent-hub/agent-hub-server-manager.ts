import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AgentHub } from '@brainstrike/agent-hub';
import { createLogger } from '@brainstrike/utils';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type AgentHubRuntimeConfig, assertAgentHubConfig } from './agent-hub-config';
import { type AgentHubContextProvider, buildAgentHubMcpServer } from './agent-hub-tools';

const logger = createLogger('AgentHubServer');

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type AgentHubServerState = 'error' | 'running' | 'stopped';

export interface AgentHubServerStatus {
  connectionCount: number;
  error: string | null;
  state: AgentHubServerState;
  /** http://<bind>:<port>/mcp while running. */
  url: string | null;
}

export interface AgentHubServerManager {
  applyConfig(config: AgentHubRuntimeConfig): Promise<AgentHubServerStatus>;
  getConfig(): AgentHubRuntimeConfig;
  getStatus(): AgentHubServerStatus;
  onStatusChange(cb: (status: AgentHubServerStatus) => void): () => void;
  start(): Promise<AgentHubServerStatus>;
  stop(): Promise<void>;
}

export interface CreateAgentHubServerManagerOptions {
  config: AgentHubRuntimeConfig;
  contextProvider?: AgentHubContextProvider;
  hub: AgentHub;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length === 0 ? undefined : JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

export function createAgentHubServerManager(
  options: CreateAgentHubServerManagerOptions
): AgentHubServerManager {
  const { contextProvider, hub } = options;
  let config = options.config;
  let server: http.Server | null = null;
  let url: string | null = null;
  let state: AgentHubServerState = 'stopped';
  let lastError: string | null = null;
  const sessions = new Map<string, SessionEntry>();
  const statusListeners = new Set<(status: AgentHubServerStatus) => void>();

  function getStatus(): AgentHubServerStatus {
    return { connectionCount: sessions.size, error: lastError, state, url };
  }

  function notifyStatus(): void {
    const status = getStatus();
    for (const listener of statusListeners) {
      listener(status);
    }
  }

  function isAuthorized(req: http.IncomingMessage): boolean {
    if (config.authToken === null) {
      return true;
    }
    const provided = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${config.authToken}`, 'utf8');
    // Length-checked constant-time compare: the token is the only protection
    // on non-loopback binds, so avoid a remote timing side-channel.
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  function removeSession(sessionId: string): void {
    if (!sessions.delete(sessionId)) {
      return;
    }
    hub.disconnectAgent(sessionId);
    notifyStatus();
  }

  async function handleInitialize(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      onsessioninitialized: (sessionId: string): void => {
        sessions.set(sessionId, entry);
        notifyStatus();
      },
      sessionIdGenerator: () => randomUUID(),
    });
    const mcpServer = buildAgentHubMcpServer({
      getSessionKey: (): string => {
        const sessionId = transport.sessionId;
        if (!sessionId) {
          throw new Error('Session not initialized yet.');
        }
        return sessionId;
      },
      hub,
      ...(contextProvider ? { contextProvider } : {}),
    });
    const entry: SessionEntry = { server: mcpServer, transport };
    transport.onclose = (): void => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        removeSession(sessionId);
      }
    };
    // The SDK's Transport interface declares `sessionId?: string` without
    // `| undefined`, which is incompatible with this app's
    // exactOptionalPropertyTypes main build even though the runtime contract
    // is identical. Single localized cast until the SDK types are eOPT-clean.
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
    await transport.handleRequest(req, res, body);
  }

  async function handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string | undefined,
    session: SessionEntry | undefined
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (session) {
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!sessionId && isInitializeRequest(body)) {
      await handleInitialize(req, res, body);
      return;
    }
    writeJson(res, 400, {
      error: 'Unknown or missing mcp-session-id. Start a new session with an initialize request.',
    });
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    if (requestUrl.pathname !== MCP_PATH) {
      writeJson(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
      return;
    }
    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: 'Unauthorized. Provide "Authorization: Bearer <token>".' });
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (req.method === 'POST') {
      await handlePost(req, res, sessionId, session);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!session) {
        writeJson(res, 404, { error: 'Unknown or missing mcp-session-id.' });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    writeJson(res, 405, { error: `Method ${req.method ?? 'UNKNOWN'} not allowed.` });
  }

  function start(): Promise<AgentHubServerStatus> {
    if (state === 'running') {
      return Promise.resolve(getStatus());
    }
    try {
      assertAgentHubConfig(config);
    } catch (error) {
      state = 'error';
      lastError = error instanceof Error ? error.message : String(error);
      notifyStatus();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<AgentHubServerStatus>((resolve, reject) => {
      const httpServer = http.createServer((req, res) => {
        handleRequest(req, res).catch((error: unknown) => {
          logger.error('Agent hub request failed', { error: String(error) });
          if (res.headersSent) {
            res.end();
          } else {
            writeJson(res, 500, { error: 'Agent hub server error.' });
          }
        });
      });
      httpServer.once('error', (error: Error) => {
        state = 'error';
        lastError = error.message;
        server = null;
        url = null;
        notifyStatus();
        reject(error);
      });
      httpServer.listen(config.port, config.bindAddress, () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : config.port;
        server = httpServer;
        url = `http://${config.bindAddress}:${port}${MCP_PATH}`;
        state = 'running';
        lastError = null;
        logger.info('Agent hub MCP server listening', { url });
        notifyStatus();
        resolve(getStatus());
      });
    });
  }

  async function stop(): Promise<void> {
    const closing = [...sessions.values()];
    sessions.clear();
    for (const entry of closing) {
      const sessionId = entry.transport.sessionId;
      if (sessionId) {
        hub.disconnectAgent(sessionId);
      }
      await entry.transport.close().catch((error: unknown) => {
        logger.warn('Failed to close agent hub session transport', { error: String(error) });
      });
    }
    const current = server;
    server = null;
    url = null;
    if (current) {
      current.closeAllConnections();
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
    }
    if (state !== 'error') {
      state = 'stopped';
    }
    logger.info('Agent hub MCP server stopped');
    notifyStatus();
  }

  async function applyConfig(next: AgentHubRuntimeConfig): Promise<AgentHubServerStatus> {
    const validated = assertAgentHubConfig(next);
    await stop();
    config = validated;
    hub.setMaxMessagesPerChannel(validated.maxMessagesPerChannel);
    state = 'stopped';
    lastError = null;
    if (validated.enabled) {
      return await start();
    }
    notifyStatus();
    return getStatus();
  }

  return {
    applyConfig,
    getConfig: () => config,
    getStatus,
    onStatusChange: (cb) => {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    start,
    stop,
  };
}
