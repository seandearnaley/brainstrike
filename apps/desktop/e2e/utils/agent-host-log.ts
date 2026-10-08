import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { attachAgentHost, type HostClient } from '@brainstrike/agent-host/client';
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
