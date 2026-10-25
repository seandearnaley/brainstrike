import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { attachAgentHost } from '@brainstrike/agent-host';

/** Each committed row carries its time, so the rows show which phase of a failed run stalled. */
export async function writeCommittedThreadRows(
  client: Awaited<ReturnType<typeof attachAgentHost>> | undefined,
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
