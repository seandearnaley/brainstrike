import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { authenticateHostClient, type HostClient } from '@brainstrike/agent-host/client';
import type { HostChildStatus, HostLogRow, HostResults } from '@brainstrike/agent-host/protocol';
import { foldHostRuns, type HostRunView } from '@brainstrike/agent-host/thread-view';
import type { Frame, Page } from '@playwright/test';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc/node';
import { launchedApp } from './launched-apps';

/** One committed MCP input fact, reduced to the fields a spec asserts on. */
interface McpInputFact {
  readonly action?: string;
  readonly status?: string;
  readonly type: string;
}

export interface AgentHostLogSummary {
  readonly mcpInputs: readonly McpInputFact[];
  readonly threads: number;
  readonly typeCounts: Readonly<Record<string, number>>;
}

/**
 * Resolves once the app's agent host is ready, through the visible frame's own attach path
 * (`agent:host-connect`). Main answers it only after acquiring the profile host, which
 * waits for the host's `ready` report. Call it after a launch or restart before any
 * reader below. Do not poll a reader instead: in Playwright 1.64, a throwing `expect.poll`
 * callback ends the poll rather than retrying. The probe client this opens is closed, and
 * Main's relay for it retired, before this returns.
 */
export async function waitForAppHost(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = window.agentHost;
    if (!bridge) {
      throw new Error('Agent host client capability is unavailable');
    }
    const requestId = crypto.randomUUID();
    const connected = Promise.withResolvers<MessagePort>();
    const disconnected = Promise.withResolvers<void>();
    const receive = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (
        event.source !== window ||
        !data ||
        typeof data !== 'object' ||
        !('type' in data && 'payload' in data && data.payload) ||
        typeof data.payload !== 'object' ||
        !('requestId' in data.payload) ||
        data.payload.requestId !== requestId
      ) {
        return;
      }
      if (data.type === 'agent-host/disconnected') {
        disconnected.resolve();
        connected.reject(new Error('Agent host client disconnected before attach'));
      } else if (data.type === 'agent-host/connected') {
        const port = event.ports[0];
        if (port) {
          connected.resolve(port);
        } else {
          connected.reject(new Error('Agent host attach transferred no port'));
        }
      }
    };
    // Observed when awaited below; this only keeps an early refusal from going unhandled.
    connected.promise.catch(() => undefined);
    window.addEventListener('message', receive);
    try {
      const result = await bridge.connect(requestId);
      if (!result.ok) {
        throw new Error(`Agent host attach refused: ${result.error.message}`);
      }
      (await connected.promise).close();
      await disconnected.promise;
    } finally {
      window.removeEventListener('message', receive);
    }
  });
}

const HOST_MESSAGE_BINDING = '__brainstrikeE2EHostMessage';
declare global {
  interface Window {
    /** This process's binding, exposed as {@link HOST_MESSAGE_BINDING}. */
    __brainstrikeE2EHostMessage?: (id: string, message: unknown) => void;
    /** Ports `attachHostThroughWindow` holds in the frame, by client id. */
    __e2eHostPorts?: Map<string, MessagePort>;
  }
}
/** vscode-jsonrpc's `Message` is any object naming its JSON-RPC version. */
function isJsonRpcMessage(value: unknown): value is Message {
  return (
    typeof value === 'object' && value !== null && 'jsonrpc' in value && value.jsonrpc === '2.0'
  );
}
const boundPages = new WeakSet<Page>();
const transports = new Map<string, (message: unknown) => void>();

/** The app's visible window: its frame is the only client a host child accepts. */
async function visibleWindow(userDataDir: string): Promise<Page> {
  const app = launchedApp(userDataDir);
  if (!app) {
    throw new Error(`No launched app for ${userDataDir}`);
  }
  for (const page of app.windows()) {
    if (!page.isClosed() && (await page.evaluate(() => 'agentHost' in window).catch(() => false))) {
      return page;
    }
  }
  throw new Error(`The app for ${userDataDir} has no visible window`);
}
async function bindHostMessages(page: Page): Promise<void> {
  if (boundPages.has(page)) {
    return;
  }
  boundPages.add(page);
  await page.exposeBinding(HOST_MESSAGE_BINDING, (_source, id: string, message: unknown) => {
    transports.get(id)?.(message);
  });
}

/**
 * A client of the running app's host, connected the way the visible frame connects
 * (`agent:host-connect`): the frame holds the port, and this test process speaks
 * JSON-RPC through it. `close` closes that port.
 */
export async function attachAppHost(userDataDir: string): Promise<HostClient> {
  return await attachHostThroughWindow(await visibleWindow(userDataDir));
}
const sharedClients = new Map<Page, Promise<HostClient>>();
/**
 * The readers' one client of the app's host, per window: attached on first use and kept
 * until its channel closes, the window navigates (a reload drops the frame's port) or
 * the window closes. Readers never close it.
 */
function sharedAppHost(userDataDir: string): Promise<HostClient> {
  return visibleWindow(userDataDir).then((page) => {
    const current = sharedClients.get(page);
    if (current) {
      return current;
    }
    const attached = attachHostThroughWindow(page);
    sharedClients.set(page, attached);
    const navigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) {
        forget();
      }
    };
    const forget = (): void => {
      page.off('framenavigated', navigated);
      if (sharedClients.get(page) === attached) {
        sharedClients.delete(page);
        attached.then((client) => client.close()).catch(() => undefined);
      }
    };
    page.on('framenavigated', navigated);
    page.once('close', forget);
    attached.then((client) => client.closed).then(forget, forget);
    return attached;
  });
}

/** {@link attachAppHost} through a window the caller already holds. */
export async function attachHostThroughWindow(page: Page): Promise<HostClient> {
  await bindHostMessages(page);
  const id = randomUUID();
  const closed = Promise.withResolvers<void>();
  let receive: DataCallback | undefined;
  transports.set(id, (message) => {
    if (message === null) {
      transports.delete(id);
      closed.resolve();
    } else if (isJsonRpcMessage(message)) {
      receive?.(message);
    }
  });
  const reader = new (class extends AbstractMessageReader implements MessageReader {
    listen(callback: DataCallback): Disposable {
      receive = callback;
      return { dispose: () => (receive = undefined) };
    }
  })();
  const writer = new (class extends AbstractMessageWriter implements MessageWriter {
    async write(message: Message): Promise<void> {
      await page.evaluate(([port, data]) => window.__e2eHostPorts?.get(port)?.postMessage(data), [
        id,
        message,
      ] as const);
    }
    end(): void {}
  })();
  const host = await page.evaluate(async (portId) => {
    const owner = window;
    const bridge = owner.agentHost;
    const deliver = owner.__brainstrikeE2EHostMessage;
    if (!(bridge && deliver)) {
      throw new Error('Agent host client capability is unavailable');
    }
    const requestId = crypto.randomUUID();
    const connected = Promise.withResolvers<{ data: object; port: MessagePort | undefined }>();
    connected.promise.catch(() => undefined);
    const receive = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (
        event.source !== window ||
        !data ||
        typeof data !== 'object' ||
        !('type' in data && 'payload' in data && data.payload) ||
        typeof data.payload !== 'object' ||
        !('requestId' in data.payload) ||
        data.payload.requestId !== requestId
      ) {
        return;
      }
      if (data.type === 'agent-host/disconnected') {
        window.removeEventListener('message', receive);
        owner.__e2eHostPorts?.delete(portId);
        connected.reject(new Error('Agent host client disconnected before attach'));
        deliver(portId, null);
      } else if (data.type === 'agent-host/connected') {
        connected.resolve({ data: data.payload, port: event.ports[0] });
      }
    };
    window.addEventListener('message', receive);
    const result = await bridge.connect(requestId);
    if (!result.ok) {
      window.removeEventListener('message', receive);
      throw new Error(`Agent host attach refused: ${result.error.message}`);
    }
    const { data, port } = await connected.promise;
    if (!port) {
      throw new Error('Agent host attach transferred no port');
    }
    const host = 'host' in data ? data.host : undefined;
    owner.__e2eHostPorts ??= new Map();
    owner.__e2eHostPorts.set(portId, port);
    port.onmessage = (event) => deliver(portId, event.data);
    port.start();
    return host;
  }, id);
  if (
    !(host && typeof host === 'object' && 'hostVersion' in host && 'protocolVersion' in host) ||
    typeof host.hostVersion !== 'string' ||
    typeof host.protocolVersion !== 'number'
  ) {
    throw new Error('The app sent no host versions to expect');
  }
  const connection = createMessageConnection(reader, writer);
  void closed.promise.then(() => connection.dispose());
  return await authenticateHostClient(
    connection,
    { hostVersion: host.hostVersion, protocolVersion: host.protocolVersion },
    async () => {
      transports.delete(id);
      await page
        .evaluate((port) => {
          const ports = window.__e2eHostPorts;
          ports?.get(port)?.close();
          ports?.delete(port);
        }, id)
        .catch(() => undefined);
      closed.resolve();
    },
    closed.promise
  );
}

/** The running app's agent host process, as its initialize reply names it. */
export async function readHostProcess(
  userDataDir: string
): Promise<{ readonly pid: number; readonly start: string }> {
  // A fresh client: its initialize reply names the host running now, even after a restart.
  const client = await attachAppHost(userDataDir);
  try {
    return { pid: client.host.pid, start: client.host.start };
  } finally {
    await client.close();
  }
}
/** The host Root: the directory of the app's state store under its user data. */
async function hostRootPath(userDataDir: string): Promise<string> {
  const entries = await readdir(userDataDir, { recursive: true });
  const match = entries.find((entry) => path.basename(String(entry)) === 'state.db');
  if (!match) {
    throw new Error(`No state.db under ${userDataDir}`);
  }
  return path.dirname(path.join(userDataDir, String(match)));
}

/** One committed MCP Tasks row in the host Root's StateStore. */
export interface CommittedMcpTask {
  readonly status: string;
  readonly taskId: string;
  readonly threadId: string | null;
}

/** The host Root's committed MCP Tasks rows, read-only while the host has it open. */
export async function readCommittedMcpTasks(
  userDataDir: string
): Promise<readonly CommittedMcpTask[]> {
  const root = await hostRootPath(userDataDir);
  const db = new DatabaseSync(path.join(root, 'state.db'), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT task_id, thread_id, status FROM brainstrike_mcp_tasks ORDER BY created_at, task_id'
      )
      .all()
      .map((row) => ({
        status: String(row['status']),
        taskId: String(row['task_id']),
        threadId: row['thread_id'] === null ? null : String(row['thread_id']),
      }));
  } finally {
    db.close();
  }
}

/** Runs `use` with a public client of the running app's host, closed afterwards. */
export async function withAppHost<T>(
  userDataDir: string,
  use: (client: HostClient) => Promise<T>
): Promise<T> {
  const client = await attachAppHost(userDataDir);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

/** The host's searchable conversation rows and their stored search vectors, read-only. */
export async function readHostSearchVectorCounts(
  userDataDir: string
): Promise<{ readonly rows: number; readonly vectors: number }> {
  const root = await hostRootPath(userDataDir);
  const db = new DatabaseSync(path.join(root, 'state-index.sqlite'), { readOnly: true });
  try {
    const count = (sql: string): number => Number(db.prepare(sql).get()?.['count'] ?? 0);
    return {
      rows: count('SELECT count(*) AS count FROM state_search_rows'),
      vectors: count('SELECT count(*) AS count FROM state_search_vectors'),
    };
  } finally {
    db.close();
  }
}

/** A thread's committed runs, oldest first, folded from its host log. */
export async function readCommittedRuns(
  userDataDir: string,
  threadId: string
): Promise<readonly HostRunView[]> {
  const client = await sharedAppHost(userDataDir);
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  return foldHostRuns(rows);
}

/** A thread's latest committed run status (`running`, or its `run.finished` outcome), or null before its first run. */
export async function readCommittedRunStatus(
  userDataDir: string,
  threadId: string
): Promise<HostRunView['status'] | null> {
  return (await readCommittedRuns(userDataDir, threadId)).at(-1)?.status ?? null;
}

export async function readAgentHostLog(userDataDir: string): Promise<AgentHostLogSummary> {
  const client = await sharedAppHost(userDataDir);
  const { threads } = await client.request('thread/list', {});
  const mcpInputs: McpInputFact[] = [];
  const typeCounts: Record<string, number> = {};
  for (const { threadId } of threads) {
    const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
    for (const { event } of rows) {
      typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
      if (event.type.startsWith('mcp.input.')) {
        mcpInputs.push({
          type: event.type,
          ...('action' in event ? { action: String(event.action) } : {}),
          ...('status' in event ? { status: String(event.status) } : {}),
        });
      }
    }
  }
  return { mcpInputs, threads: threads.length, typeCounts };
}

/** A thread's saved workspace (open tabs and selection) as the host keeps it; null before its first save. */
export async function readHostThreadWorkspace(
  userDataDir: string,
  threadId: string
): Promise<HostResults['thread/workspace/read']['snapshot']> {
  const client = await sharedAppHost(userDataDir);
  return (await client.request('thread/workspace/read', { threadId })).snapshot;
}

/** The running app's host Root: the directory of its published record. */
export async function readHostRoot(userDataDir: string): Promise<string> {
  return await hostRootPath(userDataDir);
}

/**
 * The spooled blobs a thread's stored rows reference, read from the Root's
 * StateStore: each row's `blob` hash, as the store spools a large event.
 */
export function readSpooledBlobHashes(root: string, threadId: string): readonly string[] {
  const db = new DatabaseSync(path.join(root, 'state.db'), { readOnly: true });
  try {
    const hashes = db
      .prepare('SELECT payload FROM run_events WHERE thread_id = ? ORDER BY seq')
      .all(threadId)
      .flatMap((row) => {
        const payload: unknown = JSON.parse(String(row['payload']));
        const blob =
          payload && typeof payload === 'object' && 'blob' in payload ? payload.blob : undefined;
        return typeof blob === 'string' ? [blob] : [];
      });
    return [...new Set(hashes)];
  } finally {
    db.close();
  }
}

/** Whether the host still holds a thread: a deleted thread's read is refused as unknown. */
export async function hostThreadExists(userDataDir: string, threadId: string): Promise<boolean> {
  const client = await sharedAppHost(userDataDir);
  try {
    await client.request('thread/read', { fromSeq: 0, threadId });
    return true;
  } catch (error) {
    if (error instanceof Error && /Unknown thread/u.test(error.message)) {
      return false;
    }
    throw error;
  }
}

/** One committed thread of a delegation tree: its rows and the parent it was delegated from. */
export interface HostThreadLog {
  /** A child's call sign, family colour and status, as the host lists it under its parent. */
  readonly child?: {
    readonly callSign: string;
    readonly color: string;
    readonly status: HostChildStatus;
  };
  readonly parentThreadId?: string;
  readonly rows: readonly HostLogRow[];
  readonly threadId: string;
}

/**
 * BST-1932: every committed thread, top-level threads first and then, level by
 * level, the children the host lists under each, running or settled. Child
 * threads never appear in the thread list; `thread/children` reaches them.
 */
export async function readHostThreadTree(userDataDir: string): Promise<readonly HostThreadLog[]> {
  const client = await sharedAppHost(userDataDir);
  const { threads } = await client.request('thread/list', {});
  const pending: Omit<HostThreadLog, 'rows'>[] = threads.map(({ threadId }) => ({ threadId }));
  const logs: HostThreadLog[] = [];
  for (let next = pending.shift(); next; next = pending.shift()) {
    const { rows } = await client.request('thread/read', { fromSeq: 0, threadId: next.threadId });
    logs.push({ ...next, rows });
    const { children } = await client.request('thread/children', { threadId: next.threadId });
    for (const { callSign, color, status, threadId } of children) {
      pending.push({
        child: { callSign, color, status },
        parentThreadId: next.threadId,
        threadId,
      });
    }
  }
  return logs;
}

/** Read-only acceptance receipts from the existing host writer, never a renderer SQL capability. */
export async function readHostRootRecords(
  userDataDir: string
): Promise<readonly { id: string; path: string; status: string; displayName: string }[]> {
  const db = new DatabaseSync(path.join(await hostRootPath(userDataDir), 'state.db'), {
    readOnly: true,
  });
  try {
    return db
      .prepare('SELECT id,path,status,display_name AS displayName FROM roots ORDER BY id')
      .all()
      .map((row) => ({
        displayName: String(row['displayName']),
        id: String(row['id']),
        path: String(row['path']),
        status: String(row['status']),
      }));
  } finally {
    db.close();
  }
}

/** The host's cached pull requests, read-only beside its record. */
export async function readHostForgePrs(
  userDataDir: string
): Promise<readonly { number: number; state: string }[]> {
  const db = new DatabaseSync(path.join(await hostRootPath(userDataDir), 'state.db'), {
    readOnly: true,
  });
  try {
    return db
      .prepare('SELECT number, state FROM brainstrike_forge_prs ORDER BY repo_common_dir, branch')
      .all()
      .map((row) => ({ number: Number(row['number']), state: String(row['state']) }));
  } finally {
    db.close();
  }
}

export async function readHostRetiredTableSnapshot(
  userDataDir: string,
  tables: readonly string[]
): Promise<Record<string, { digest: string; rows: number } | 'absent'>> {
  const db = new DatabaseSync(path.join(await hostRootPath(userDataDir), 'state.db'), {
    readOnly: true,
  });
  try {
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row['name']))
    );
    return Object.fromEntries(
      tables.map((table) => {
        if (!names.has(table)) {
          return [table, 'absent'];
        }
        const records = db
          .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
        return [
          table,
          {
            digest: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
            rows: records.length,
          },
        ];
      })
    );
  } finally {
    db.close();
  }
}
