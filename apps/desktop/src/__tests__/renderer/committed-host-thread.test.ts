/**
 * The shared committed conversation core (BST-1940) over a scripted host
 * client: what a send asks the host for, how a refusal reaches the composer,
 * Stop, and when the session subscribes.
 */
import { type AppendMessage, isMessageNotSentError } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_RUN_NOT_ADMITTED_CODE,
  type HostLogRow,
  type HostMethod,
} from '@brainstrike/agent-host/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommittedHostThread,
  createCommittedHostThread,
} from '../../renderer/committed-host-thread';

const THREAD = 'thread-1';
const RUN = 'run-1';

/** A committed thread with one run still running. */
const running: HostLogRow[] = [
  { event: { commandId: 'start', type: 'thread.started' }, seq: 1, threadId: THREAD, ts: 1 },
  {
    event: {
      commandId: 'run',
      method: 'run/start',
      payload: { commandId: 'run', modelId: 'openai', prompt: 'Hi', threadId: THREAD },
      result: { runId: RUN },
      type: 'command.accepted',
    },
    seq: 2,
    threadId: THREAD,
    ts: 2,
  },
  {
    event: {
      modelId: 'openai',
      parentMessageId: null,
      prompt: 'Hi',
      runId: RUN,
      type: 'run.started',
    },
    seq: 3,
    threadId: THREAD,
    ts: 3,
  },
];

function scriptedClient(
  rows: readonly HostLogRow[],
  answer: (method: HostMethod, params: unknown, commit: (row: HostLogRow) => void) => unknown
) {
  const requests: { readonly method: HostMethod; readonly params: unknown }[] = [];
  const subscribers = new Set<(row: HostLogRow) => void>();
  /** A row the host commits and publishes to its subscribers, before it answers. */
  const commit = (row: HostLogRow): void => {
    for (const subscriber of subscribers) {
      subscriber(row);
    }
  };
  const client: Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry' | 'request'> = {
    closed: new Promise(() => {}),
    onEvent: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    onTelemetry: () => () => {},
    request: (async (method: HostMethod, params: unknown) => {
      requests.push({ method, params });
      if (method === 'log/subscribe') {
        return { rows, subscriptionId: 'subscription-1', telemetry: [] };
      }
      if (method === 'log/unsubscribe') {
        return { unsubscribed: true };
      }
      return answer(method, params, commit);
    }) as HostClient['request'],
  };
  return { client, requests };
}

function message(text: string, extra: Partial<AppendMessage> = {}): AppendMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId: 'run-0',
    role: 'user',
    runConfig: undefined,
    sourceId: null,
    ...extra,
  };
}

const threads: CommittedHostThread[] = [];
afterEach(() => {
  for (const thread of threads.splice(0)) {
    thread.close();
  }
});

function open(client: ReturnType<typeof scriptedClient>['client']): CommittedHostThread {
  const thread = createCommittedHostThread({
    client,
    runSettings: () => ({ configuration: { provider: 'openai' }, modelId: 'openai' }),
    threadId: THREAD,
  });
  threads.push(thread);
  return thread;
}

describe('the shared committed conversation core (BST-1940)', () => {
  it("sends a message as the host's run/start: its text, images, parent and the run settings", async () => {
    const { client, requests } = scriptedClient([], () => ({ runId: RUN }));
    const thread = open(client);
    thread.connect();

    await thread.commands.onNew(
      message('Look at this', {
        attachments: [
          {
            content: [{ image: 'aGk=', type: 'image' }],
            contentType: 'image/PNG',
            id: 'a1',
            name: 'shot.png',
            status: { type: 'complete' },
            type: 'image',
          },
        ],
      })
    );

    const start = requests.find(({ method }) => method === 'run/start')?.params;
    expect(start).toEqual({
      attachments: [{ data: 'aGk=', mediaType: 'image/png', name: 'shot.png', type: 'image' }],
      commandId: expect.any(String),
      configuration: { provider: 'openai' },
      modelId: 'openai',
      parentMessageId: 'run-0',
      prompt: 'Look at this',
      threadId: THREAD,
    });
  });

  it('shows the run as running once its send settles, so the composer offers no second send the host would refuse (BST-2439)', async () => {
    // The host commits the run, publishes its rows, then answers run/start.
    const { client } = scriptedClient(running.slice(0, 1), (method, _params, commit) => {
      if (method !== 'run/start') {
        return {};
      }
      for (const row of running.slice(1)) {
        commit(row);
      }
      return { runId: RUN };
    });
    const thread = open(client);
    thread.connect();
    await expect.poll(() => thread.store.getSnapshot().isLoading).toBe(false);
    expect(thread.store.getSnapshot().isRunning).toBe(false);

    await thread.commands.onNew(message('Hi', { parentId: null }));
    expect(thread.store.getSnapshot().isRunning).toBe(true);
    expect(thread.store.getCommittedView().activeRunId).toBe(RUN);
  });

  it('gives the composer its draft back when the host refuses the run before admitting it', async () => {
    const { client } = scriptedClient([], () => {
      throw Object.assign(new Error('The thread already has an active root run'), {
        code: HOST_RUN_NOT_ADMITTED_CODE,
      });
    });
    const thread = open(client);
    thread.connect();

    const refused = await thread.commands.onNew(message('Again')).catch((cause: unknown) => cause);
    expect(isMessageNotSentError(refused)).toBe(true);
  });

  it("stops the thread's active run, and refuses a Stop with no run active", async () => {
    const { client, requests } = scriptedClient(running, () => ({ outcome: 'stopped' }));
    const thread = open(client);
    thread.connect();
    await expect.poll(() => thread.store.getCommittedView().activeRunId).toBe(RUN);

    await thread.commands.onCancel();
    expect(requests.find(({ method }) => method === 'run/stop')?.params).toEqual({
      commandId: expect.any(String),
      runId: RUN,
      threadId: THREAD,
    });

    const idle = open(scriptedClient([], () => ({})).client);
    idle.connect();
    await expect(idle.commands.onCancel()).rejects.toThrow('Stop has no committed active root run');
  });

  it('tells its tabs when the host moves the thread into a worktree, as it does for a rename', async () => {
    const moved: HostLogRow = {
      event: {
        binding: {
          checkoutMode: 'worktree',
          operatingRootDisplayName: 'fox',
          operatingRootId: 'wt-root',
          operatingRootPath: '/managed/fox',
        },
        type: 'workspace.binding.updated',
      },
      seq: 4,
      threadId: THREAD,
      ts: 4,
    };
    const committed: number[] = [];
    const thread = createCommittedHostThread({
      client: scriptedClient([...running, moved], () => ({})).client,
      onEntryCommitted: () => committed.push(thread.source.getSnapshot().rows.length),
      runSettings: () => ({ configuration: { provider: 'openai' }, modelId: 'openai' }),
      threadId: THREAD,
    });
    threads.push(thread);
    thread.connect();

    await expect.poll(() => committed).toEqual([4]);
  });

  it('subscribes the session only when connected, so a part composed first sees its replay', async () => {
    const { client, requests } = scriptedClient(running, () => ({}));
    const thread = open(client);
    const seen: number[][] = [];
    // A caller's own part of the view, composed over the session before it connects.
    thread.source.subscribe(() =>
      seen.push(thread.source.getSnapshot().rows.map((row) => row.seq))
    );
    expect(requests).toEqual([]);

    thread.connect();
    thread.connect();

    await expect.poll(() => seen.at(-1)).toEqual([1, 2, 3]);
    expect(requests.filter(({ method }) => method === 'log/subscribe')).toHaveLength(1);
  });
});
