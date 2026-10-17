/**
 * The web shell's thread host on the shared log (BST-1940), as the shell uses
 * it: threads listed, started, renamed, bound and deleted through the browser
 * host client, and a thread rendered as the shared committed conversation. A
 * message sent from its composer runs through Hosted Web's own turn (over a
 * scripted model) and is recorded on a scripted writer.
 */

import { locks } from 'node:worker_threads';
import {
  createStatelessAssistantDataStreamResponse,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { TooltipProvider } from '@brainstrike/ui';
import { scriptedWriter } from '@brainstrike/web-writer/test-fixtures/scripted-writer';
import { WebHostClient } from '@brainstrike/web-writer/web-host-client';
import { hostedWebRunTurn } from '@brainstrike/web-writer/web-run-turn';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWebThreadHost } from '../web-thread-host';

const answering = (text: string) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 't1', type: 'text-start' },
          { delta: text, id: 't1', type: 'text-delta' },
          { id: 't1', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 11, total: 11 },
              outputTokens: { reasoning: 0, text: 7, total: 7 },
            },
          },
        ] as never,
        initialDelayInMs: null,
      }),
    }),
  });

/** Hosted Web's own turn and data stream, in process, for each recorded request. */
const proxyTurn = (text: string) =>
  hostedWebRunTurn('https://web.test/api/assistant', async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly messages: Parameters<typeof streamHostedWebTurn>[0]['messages'];
    };
    return createStatelessAssistantDataStreamResponse(
      await streamHostedWebTurn({
        messages: body.messages,
        model: answering(text),
        recordSteps: true,
      })
    );
  });

// happy-dom's navigator has no Web Locks; Node's own LockManager stands in for the browser's.
beforeAll(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
});

const clients: WebHostClient[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function host(text = 'Hello from the proxy') {
  const writer = scriptedWriter();
  const client = await WebHostClient.open(writer.store, { turn: proxyTurn(text) });
  clients.push(client);
  return { client, threads: createWebThreadHost({ client, readModelId: () => 'openai' }), writer };
}

describe("the web shell's thread host (BST-1940)", () => {
  it('lists, renames, colours and deletes the threads it starts, and refuses a binding it does not keep', async () => {
    const { threads } = await host();

    const started = await threads.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(await threads.ownsThread(started.id)).toBe(true);
    expect(await threads.ownsThread('another-thread')).toBe(false);

    await threads.renameThread(started.id, 'Kestrel');
    await threads.updateThreadBinding(started.id, { color: 'blue' });
    expect(await threads.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([
      expect.objectContaining({ id: started.id, metadata: { color: 'blue' }, title: 'Kestrel' }),
    ]);
    await expect(
      threads.updateThreadBinding(started.id, { operatingRootId: 'root-1' })
    ).rejects.toThrow('Web threads keep no operatingRootId; nothing was changed.');

    expect(await threads.deleteThread(started.id)).toEqual([started.id]);
    expect(await threads.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([]);
    expect(await threads.deleteThread(started.id)).toBeUndefined();
  });

  it('lists no thread another tab deleted, and owns none, though deletion is never announced', async () => {
    const { threads, writer } = await host();
    const other = await WebHostClient.open(writer.store);
    clients.push(other);
    const { id } = await threads.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
    await expect.poll(async () => (await other.request('thread/list', {})).threads.length).toBe(1);

    await createWebThreadHost({ client: other, readModelId: () => 'openai' }).deleteThread(id);

    expect(await threads.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([]);
    expect(await threads.ownsThread(id)).toBe(false);
  });

  it("keeps each thread's workspace snapshot through the host, as desktop's does", async () => {
    const { threads } = await host();
    const { id } = await threads.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
    const repository = threads.workspaceRepository();
    expect(await repository.getThreadWorkspace(id)).toBeNull();

    const empty = EMPTY_WORKSPACE_SNAPSHOT;
    await repository.setThreadWorkspace(id, WORKSPACE_MEMORY_RESOURCE_ID, empty);

    expect(await repository.getThreadWorkspace(id)).toEqual(empty);
    expect([...(await repository.getThreadWorkspaces([id])).keys()]).toEqual([id]);
    await expect(repository.getThreadWorkspace('another-thread')).rejects.toThrow(
      'This workspace snapshot is not owned by the attached agent host.'
    );
  });

  it('renders a thread as the shared committed conversation: a message sent from its composer is answered and recorded', async () => {
    const user = userEvent.setup();
    const { threads, writer } = await host('Hello from the proxy');
    const { id } = await threads.createThread(WORKSPACE_MEMORY_RESOURCE_ID);

    // Under StrictMode, as the app mounts: the view's replayed effect starts no second subscription.
    render(
      <StrictMode>
        <TooltipProvider>{threads.renderThread(id, true)}</TooltipProvider>
      </StrictMode>
    );
    // The composer opens once the thread's committed history has loaded.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message input' })).toBeEnabled()
    );
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Say hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Hello from the proxy')).toBeTruthy();
    expect(screen.getByText('Say hello')).toBeTruthy();
    // Recorded on the writer as Core commits a run.
    const committed = (writer.logs.get(id) ?? []).map(
      (row) => (JSON.parse(row.payload) as { type: string }).type
    );
    expect(committed).toContain('model.step');
    expect(committed.at(-1)).toBe('run.finished');
  });
});
