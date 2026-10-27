/**
 * The new thread's first send over a scripted host: the thread exists only
 * once a message is sent, takes the composer's choices before its run, and a
 * send the host refuses leaves no thread behind.
 */
import { type AppendMessage, isMessageNotSentError } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import { HOST_RUN_NOT_ADMITTED_CODE, type HostMethod } from '@brainstrike/agent-host/protocol';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { describe, expect, it, vi } from 'vitest';
import {
  type NewThreadFirstSend,
  sendNewThreadFirstMessage,
} from '../renderer/new-thread-first-send';

const created: AssistantMemoryThread = {
  createdAt: new Date(),
  id: 'thread-new',
  resourceId: 'workspace',
  title: 'New Thread',
  updatedAt: new Date(),
};

function message(text: string): AppendMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId: null,
    role: 'user',
    runConfig: undefined,
    sourceId: null,
  };
}

function scripted(answer: (method: HostMethod) => unknown = () => ({ runId: 'run-1' })) {
  const steps: string[] = [];
  const client: NewThreadFirstSend['client'] = {
    closed: new Promise(() => {}),
    onEvent: () => () => {},
    onTelemetry: () => () => {},
    request: (async (method: HostMethod, params: unknown) => {
      steps.push(`${method} ${JSON.stringify(params)}`);
      return answer(method);
    }) as HostClient['request'],
  };
  const send: NewThreadFirstSend = {
    bind: vi.fn(async (threadId: string) => {
      steps.push(`bind ${threadId}`);
    }),
    client,
    commit: vi.fn(async (thread: AssistantMemoryThread) => {
      steps.push(`commit ${thread.id}`);
    }),
    host: {
      createThread: vi.fn(async () => {
        steps.push('create');
        return created;
      }),
      deleteThread: vi.fn(async (threadId: string) => {
        steps.push(`delete ${threadId}`);
        return [threadId];
      }),
    },
    resourceId: 'workspace',
    runSettings: () => ({ configuration: { provider: 'openai' }, modelId: 'openai::gpt' }),
    selection: { configuration: { provider: 'openai' }, modelId: 'openai::gpt' },
  };
  return { send, steps };
}

describe('the new thread’s first send', () => {
  it('creates the thread, commits its folder and model, starts the run, then opens it', async () => {
    const { send, steps } = scripted();

    await sendNewThreadFirstMessage(send, message('Plan the release'));

    expect(steps.map((step) => step.split(' ')[0])).toEqual([
      'create',
      'bind',
      'thread/selection/set',
      'run/start',
      'commit',
    ]);
    expect(steps[2]).toContain('"modelId":"openai::gpt"');
    expect(steps[3]).toContain('"prompt":"Plan the release"');
    expect(steps[3]).toContain('"threadId":"thread-new"');
    expect(send.host.deleteThread).not.toHaveBeenCalled();
  });

  it('removes the thread and gives the composer its message back when the run is refused', async () => {
    const { send, steps } = scripted((method) => {
      if (method === 'run/start') {
        throw Object.assign(new Error('Choose an embedding model in Settings.'), {
          code: HOST_RUN_NOT_ADMITTED_CODE,
        });
      }
      return {};
    });

    const refused = await sendNewThreadFirstMessage(send, message('Hello')).catch(
      (cause: unknown) => cause
    );

    expect(isMessageNotSentError(refused)).toBe(true);
    expect(steps.at(-1)).toBe('delete thread-new');
    expect(send.commit).not.toHaveBeenCalled();
  });

  it('removes the thread when its folder cannot be bound, before any run starts', async () => {
    const { send, steps } = scripted();
    vi.mocked(send.bind).mockRejectedValueOnce(
      refusalError('availability', 'workspace.unavailable', 'That folder is no longer available.')
    );

    const refused = await sendNewThreadFirstMessage(send, message('Hello')).catch(
      (cause: unknown) => cause
    );

    expect(isMessageNotSentError(refused)).toBe(true);
    expect((refused as Error).message).toContain('That folder is no longer available.');
    expect(steps.some((step) => step.startsWith('run/start'))).toBe(false);
    expect(send.host.deleteThread).toHaveBeenCalledExactlyOnceWith('thread-new');
    expect(send.commit).not.toHaveBeenCalled();
  });

  it('keeps and opens the thread when the host may have admitted the run', async () => {
    const lost = new Error('The agent host stopped responding');
    const { send } = scripted((method) => {
      if (method === 'run/start') {
        throw lost;
      }
      return {};
    });

    await expect(sendNewThreadFirstMessage(send, message('Hello'))).rejects.toBe(lost);
    expect(send.host.deleteThread).not.toHaveBeenCalled();
    expect(send.commit).toHaveBeenCalledExactlyOnceWith(created);
  });
});
