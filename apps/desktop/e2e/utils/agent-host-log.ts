import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { attachAgentHost, type HostClient } from '@brainstrike/agent-host/client';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
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
async function attachAppHost(userDataDir: string): Promise<HostClient> {
  const entries = await readdir(userDataDir, { recursive: true });
  const match = entries.find((entry) => path.basename(String(entry)) === 'host.json');
  if (!match) {
    throw new Error(`No host.json under ${userDataDir}`);
  }
  const record = decodeHostRecord(
    JSON.parse(await readFile(path.join(userDataDir, String(match)), 'utf8'))
  );
  return attachAgentHost(record);
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

/** One committed thread of a delegation tree: its rows and the parent it was delegated from. */
export interface HostThreadLog {
  readonly parentThreadId?: string;
  readonly rows: readonly HostLogRow[];
  readonly threadId: string;
}

/** The child thread a committed delegation result names, if any. */
function delegatedChild(row: HostLogRow): string | undefined {
  if (row.event.type !== 'effect.finished') {
    return;
  }
  const output = row.event.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return;
  }
  const child = output['childThreadId'];
  return typeof child === 'string' ? child : undefined;
}

/**
 * BST-1932: every committed thread, top-level threads first and then each
 * child thread their delegation results name. Child threads never appear in
 * the thread list, so a parent's committed log is the way to reach them.
 */
export async function readHostThreadTree(userDataDir: string): Promise<readonly HostThreadLog[]> {
  const client = await attachAppHost(userDataDir);
  try {
    const { threads } = await client.request('thread/list', {});
    const pending: { parentThreadId?: string; threadId: string }[] = threads.map(
      ({ threadId }) => ({ threadId })
    );
    const logs: HostThreadLog[] = [];
    const seen = new Set<string>();
    for (let next = pending.shift(); next; next = pending.shift()) {
      if (seen.has(next.threadId)) {
        continue;
      }
      seen.add(next.threadId);
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId: next.threadId });
      logs.push({ ...next, rows });
      for (const row of rows) {
        const child = delegatedChild(row);
        if (child) {
          pending.push({ parentThreadId: next.threadId, threadId: child });
        }
      }
    }
    return logs;
  } finally {
    await client.close();
  }
}
