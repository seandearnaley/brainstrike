import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostClient } from '@brainstrike/agent-host/client';

/**
 * Each committed row carries its time, so the rows show which phase of a failed run stalled.
 * Start it without awaiting, close the client, then await it: a stuck host never answers, and
 * the close settles its pending requests.
 */
export async function writeCommittedThreadRows(
  client: HostClient | undefined,
  evidence: string
): Promise<void> {
  if (!client) {
    return;
  }
  try {
    const { threads } = await client.request('thread/list', {});
    const rows = await Promise.all(
      threads.map(async ({ threadId }) => ({
        rows: (await client.request('thread/read', { fromSeq: 0, threadId })).rows,
        threadId,
      }))
    );
    await writeFile(join(evidence, 'committed-rows.json'), JSON.stringify(rows, null, 2));
  } catch (cause) {
    await writeFile(join(evidence, 'committed-rows-failure.json'), JSON.stringify(String(cause)));
  }
}

export async function writeFirstFailure(evidence: string, cause: unknown): Promise<void> {
  await writeFile(
    join(evidence, 'first-failure.json'),
    JSON.stringify(
      { message: String(cause), stack: cause instanceof Error ? cause.stack : undefined },
      null,
      2
    )
  );
}
