/**
 * The browser's host client over the composed writer, in Chromium (BST-1940):
 * Core's own folds over the writer's log, Core's commands, and desktop's
 * committed thread session reading web threads through it.
 */
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { afterEach, describe, expect, inject, it } from 'vitest';
import { WebHostClient, type WebHostClientOptions } from '../web-host-client';
import type { WebRunTurn } from '../web-run-turn';
import { closeTabs, openTab, storeConfig, storeCorpus } from './writer-tabs';

const clients: WebHostClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await closeTabs();
});

async function client(
  tab: Awaited<ReturnType<typeof openTab>>,
  options?: WebHostClientOptions
): Promise<WebHostClient> {
  const opened = await WebHostClient.open(tab, options);
  clients.push(opened);
  return opened;
}

const types = (rows: readonly { readonly event: { readonly type: string } }[]) =>
  rows.map((row) => row.event.type);

describe("the browser's host client (BST-1940)", () => {
  it('starts, renames and reads a thread as Core commits it, and answers a repeated command once', async () => {
    const host = await client(await openTab(storeConfig()));

    const { threadId } = await host.request('thread/start', { commandId: 'start-1' });
    expect(await host.request('thread/start', { commandId: 'start-1' })).toEqual({ threadId });
    await expect(
      host.request('thread/update', { commandId: 'start-1', threadId, title: 'Reused' })
    ).rejects.toThrow('Command identity was reused with different input');

    await host.request('thread/update', { commandId: 'rename-1', threadId, title: 'Kestrel' });
    const { threads } = await host.request('thread/list', {});
    expect(threads).toEqual([
      expect.objectContaining({ binding: null, threadId, title: 'Kestrel' }),
    ]);
    expect(threads[0]?.createdAt).toBeLessThanOrEqual(threads[0]?.updatedAt ?? 0);

    const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
    expect(types(rows)).toEqual([
      'command.accepted',
      'thread.started',
      'command.accepted',
      'thread.updated',
    ]);
    expect(rows[0]?.event).toEqual({
      commandId: 'start-1',
      method: 'thread/start',
      payload: { commandId: 'start-1' },
      result: { threadId },
      type: 'command.accepted',
    });
  });

  it('reads the runs Core stored, its spooled output and run snapshot included', async () => {
    const tab = await openTab(storeConfig());
    await storeCorpus(tab);
    const host = await client(tab);
    const [richRow] = rich as readonly { readonly threadId: string }[];
    const [planRow] = plan as readonly { readonly threadId: string }[];

    const { threads } = await host.request('thread/list', {});
    expect(threads.map((thread) => thread.threadId).sort()).toEqual(
      [richRow?.threadId, planRow?.threadId].sort()
    );
    expect(threads.every((thread) => thread.latestRun !== undefined)).toBe(true);

    const read = await host.request('thread/read', {
      fromSeq: 0,
      threadId: planRow?.threadId ?? '',
    });
    expect(read.rows.map((row) => row.event)).toEqual(
      (plan as readonly { readonly event: unknown }[]).map((row) => row.event)
    );
    const richRows = (
      await host.request('thread/read', { fromSeq: 0, threadId: richRow?.threadId ?? '' })
    ).rows;
    expect(richRows).toHaveLength(rich.length);
    const spooled = richRows.find((row) => row.event.type === 'effect.finished');
    expect((spooled?.event as { readonly output?: string } | undefined)?.output).toMatch(
      /^large tool output ✓\nx{40000}$/u
    );
  });

  it("gives a second tab's client the first's threads live, and desktop's thread session reads and follows them", async () => {
    const config = storeConfig();
    const first = await client(await openTab(config));
    const second = await client(await openTab(config));

    const { threadId } = await first.request('thread/start', { commandId: 'start-2' });
    await expect
      .poll(async () => (await second.request('thread/list', {})).threads.map((t) => t.threadId))
      .toEqual([threadId]);

    const session = new CommittedThreadSession(second, threadId);
    const disconnect = session.connect();
    await expect.poll(() => session.getSnapshot().isLoading).toBe(false);
    expect(session.getSnapshot().replayedThrough).toBe(2);

    await first.request('thread/update', { commandId: 'rename-2', threadId, title: 'Followed' });
    await expect
      .poll(async () =>
        (await second.request('thread/list', {})).threads.map((thread) => thread.title)
      )
      .toEqual(['Followed']);
    const followed = new Promise<string>((resolve) => {
      const release = second.onEvent((row) => {
        if (row.event.type === 'thread.updated') {
          release();
          resolve((row.event as { readonly title?: string }).title ?? '');
        }
      });
    });
    await first.request('thread/update', { commandId: 'rename-3', threadId, title: 'Live' });
    expect(await followed).toBe('Live');
    await disconnect();
  });

  it('gives a subscriber each row once: none it replayed, however the announcements race', async () => {
    const host = await client(await openTab(storeConfig()));
    const { threadId } = await host.request('thread/start', { commandId: 'start-4' });
    const seen: number[] = [];
    host.onEvent((row) => seen.push(row.seq));
    // Subscribed while the start's own announcement may still be on its way.
    const { rows } = await host.request('log/subscribe', { fromSeq: 0, threadId });
    await host.request('thread/update', { commandId: 'rename-4', threadId, title: 'Once' });
    await expect.poll(() => seen).toEqual([3, 4]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("records a run from Hosted Web's own wire on the writer, and a second tab's thread session follows it", async () => {
    const config = storeConfig();
    const wire = inject('recordedProxyTurn');
    const turn: WebRunTurn = async () => new Response(wire);
    const first = await client(await openTab(config), { turn });
    const second = await client(await openTab(config));
    const { threadId } = await first.request('thread/start', { commandId: 'start-run' });
    const session = new CommittedThreadSession(second, threadId);
    await expect.poll(async () => (await second.request('thread/list', {})).threads.length).toBe(1);
    const disconnect = session.connect();

    const { runId } = await first.request('run/start', {
      commandId: 'run-1',
      modelId: 'openai',
      prompt: 'Say hello',
      threadId,
    });

    await expect.poll(() => types(session.getSnapshot().rows).at(-1)).toBe('run.finished');
    const rows = session.getSnapshot().rows;
    expect(types(rows).slice(2)).toEqual([
      'command.accepted',
      'run.started',
      'stream.chunk',
      'stream.chunk',
      'model.step',
      'stream.chunk',
      'stream.chunk',
      'run.finished',
    ]);
    expect(rows.find((row) => row.event.type === 'model.step')?.event).toMatchObject({
      messages: [{ content: [{ text: 'Hello from the proxy', type: 'text' }], role: 'assistant' }],
    });
    // The snapshot round-trips through the writer's blobs, read in the other tab.
    const read = await second.request('thread/read', { fromSeq: 0, threadId });
    expect(read.rows.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
      runId,
      snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {} },
    });
    await expect
      .poll(async () => (await second.request('thread/list', {})).threads[0]?.latestRun)
      .toMatchObject({ status: 'completed' });
    await disconnect();
  });

  it('deletes a thread for its tab, forgetting its commands, and serves no method it does not own', async () => {
    const host = await client(await openTab(storeConfig()));
    const { threadId } = await host.request('thread/start', { commandId: 'start-3' });
    expect(await host.request('thread/delete', { threadId })).toEqual({
      deleted: true,
      threadIds: [threadId],
    });
    expect((await host.request('thread/list', {})).threads).toEqual([]);
    await expect(host.request('thread/read', { fromSeq: 0, threadId })).rejects.toThrow(
      'Unknown thread'
    );
    // As Core forgets a deleted thread's commands: its start, repeated, starts a new thread.
    const again = await host.request('thread/start', { commandId: 'start-3' });
    expect(again.threadId).not.toBe(threadId);
    await expect(host.request('host/status', {})).rejects.toThrow(
      'The browser host does not serve host/status'
    );
  });
});
