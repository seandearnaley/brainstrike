import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachAgentHost, type HostClient } from '@brainstrike/agent-host/client';
import type { HostChildStatus, HostLogRow, HostResults } from '@brainstrike/agent-host/protocol';
import { foldHostRuns, type HostRunView } from '@brainstrike/agent-host/thread-view';
import { decodeHostRecord } from '@brainstrike/host-lease';

/** One committed MCP input fact, reduced to the fields a spec asserts on. */
export interface McpInputFact {
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
 * Reads the running app's committed agent-host log through its public client,
 * found by the host record the app publishes under its user-data directory.
 */
async function hostRecordPath(userDataDir: string): Promise<string> {
  const entries = await readdir(userDataDir, { recursive: true });
  const match = entries.find((entry) => path.basename(String(entry)) === 'host.json');
  if (!match) {
    throw new Error(`No host.json under ${userDataDir}`);
  }
  return path.join(userDataDir, String(match));
}

async function attachAppHost(userDataDir: string): Promise<HostClient> {
  const record = decodeHostRecord(
    JSON.parse(await readFile(await hostRecordPath(userDataDir), 'utf8'))
  );
  return attachAgentHost(record);
}

/** One committed MCP Tasks row in the host Root's StateStore. */
export interface CommittedMcpTask {
  readonly status: string;
  readonly taskId: string;
  readonly threadId: string | null;
}

/** The host Root's committed MCP Tasks rows, read-only beside its record. */
export async function readCommittedMcpTasks(
  userDataDir: string
): Promise<readonly CommittedMcpTask[]> {
  const root = path.dirname(await hostRecordPath(userDataDir));
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

/** A thread's committed runs, oldest first, folded from its host log. */
export async function readCommittedRuns(
  userDataDir: string,
  threadId: string
): Promise<readonly HostRunView[]> {
  const client = await attachAppHost(userDataDir);
  try {
    const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
    return foldHostRuns(rows);
  } finally {
    await client.close();
  }
}

/** A thread's latest committed run status (`running`, or its `run.finished` outcome), or null before its first run. */
export async function readCommittedRunStatus(
  userDataDir: string,
  threadId: string
): Promise<HostRunView['status'] | null> {
  return (await readCommittedRuns(userDataDir, threadId)).at(-1)?.status ?? null;
}

export async function readAgentHostLog(userDataDir: string): Promise<AgentHostLogSummary> {
  const client = await attachAppHost(userDataDir);
  try {
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
  } finally {
    await client.close();
  }
}

/** A thread's saved workspace (open tabs and selection) as the host keeps it; null before its first save. */
export async function readHostThreadWorkspace(
  userDataDir: string,
  threadId: string
): Promise<HostResults['thread/workspace/read']['snapshot']> {
  const client = await attachAppHost(userDataDir);
  try {
    return (await client.request('thread/workspace/read', { threadId })).snapshot;
  } finally {
    await client.close();
  }
}

/** Whether the host still holds a thread: a deleted thread's read is refused as unknown. */
export async function hostThreadExists(userDataDir: string, threadId: string): Promise<boolean> {
  const client = await attachAppHost(userDataDir);
  try {
    await client.request('thread/read', { fromSeq: 0, threadId });
    return true;
  } catch (error) {
    if (error instanceof Error && /Unknown thread/u.test(error.message)) {
      return false;
    }
    throw error;
  } finally {
    await client.close();
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
  const client = await attachAppHost(userDataDir);
  try {
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
  } finally {
    await client.close();
  }
}
