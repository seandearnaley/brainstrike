/**
 * BST-2004: a send whose host was lost before it answered is settled from the
 * replacement host's committed log, never resent. The rows are a recorded
 * host log (`committed-host-ended-runs.json`).
 */
import { type AppendMessage, isMessageNotSentError } from '@assistant-ui/react';
import { fromBoundaryResponseError } from '@brainstrike/agent-host/boundary-wire';
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  HOST_RESULT_SCHEMAS,
  HOST_RUN_NOT_ADMITTED_CODE,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
} from '@brainstrike/agent-host/protocol';
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-host-ended-runs.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc';
import { ThreadRootsRemovedError } from '../agent-host-platform/desktop-workspace-binding';
import {
  createCommittedHostConversation,
  HOST_RESTARTED_NOT_SENT,
} from '../renderer/committed-host-conversation';

const rows = recording.map((row) => HostLogRowSchema.parse(row));
const threadId = rows[0]?.threadId ?? '';
const acceptedStart = rows.find(
  ({ event, threadId: owner }) =>
    owner === threadId && event.type === 'command.accepted' && event.method === 'run/start'
)?.event;
if (!(threadId && acceptedStart?.type === 'command.accepted')) {
  throw new Error('The recording needs a committed run/start acceptance');
}
const acceptedCommandId = acceptedStart.commandId;

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

/** A host client serving the recorded log; `runStart` decides the send's fate. */
function recordedClient(runStart: () => Promise<unknown>) {
  const closed = Promise.withResolvers<void>();
  const request = vi.fn(async (method: HostMethod, params: HostParams<HostMethod>) => {
    const thread = (params as { readonly threadId?: string }).threadId;
    const log: HostLogRow[] = rows.filter((row) => row.threadId === thread);
    const answers: Partial<Record<HostMethod, () => unknown>> = {
      'log/subscribe': () => ({ rows: log, telemetry: [] }),
      'log/unsubscribe': () => ({ unsubscribed: true }),
      'run/start': runStart,
      'thread/children': () => ({ children: [] }),
      'thread/read': () => ({ rows: log }),
    };
    const answer = answers[method];
    if (!answer) {
      throw new Error(`Unexpected host request ${method}`);
    }
    return HOST_RESULT_SCHEMAS[method].parse(await answer());
  });
  const client = {
    close: vi.fn(async () => closed.resolve()),
    closed: closed.promise,
    onEvent: vi.fn(() => () => undefined),
    onTelemetry: vi.fn(() => () => undefined),
    request: request as unknown as HostClient['request'],
  } as unknown as HostClient;
  return { client, lose: () => closed.resolve(), request };
}

/** A `run/start` the host never answers: the closed transport rejects it, as vscode-jsonrpc does. */
function unansweredStart(lost: Promise<void>) {
  return () =>
    lost.then(() => {
      throw new Error('Pending response rejected since connection got disposed');
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a send the lost host never answered (BST-2004)', () => {
  it('comes back unsent when the replacement has no record of it', async () => {
    const loss = Promise.withResolvers<void>();
    const lostHost = recordedClient(unansweredStart(loss.promise));
    const replacementHost = recordedClient(async () => ({ runId: 'never' }));
    const replacement = vi.fn(async () => replacementHost.client);
    const conversation = createCommittedHostConversation({
      client: lostHost.client,
      modelId: 'openrouter::anthropic/claude-sonnet-4.6',
      replacement,
      threadId,
    });
    try {
      const sent = conversation.commands.onNew?.(message('Never reached the log'));
      lostHost.lose();
      loss.resolve();
      const refusal = await sent?.then(
        () => undefined,
        (cause: unknown) => cause
      );
      expect(isMessageNotSentError(refusal)).toBe(true);
      expect((refusal as Error).message).toBe(HOST_RESTARTED_NOT_SENT);
      expect(replacement).toHaveBeenCalledExactlyOnceWith(lostHost.client);
      // Nothing is resent: the replacement is only read.
      expect(replacementHost.request.mock.calls.map(([method]) => method)).toEqual(['thread/read']);
    } finally {
      conversation.close();
    }
  });

  it('settles as sent when the replacement committed it (Core marks the run interrupted)', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      acceptedCommandId as ReturnType<typeof crypto.randomUUID>
    );
    const loss = Promise.withResolvers<void>();
    const lostHost = recordedClient(unansweredStart(loss.promise));
    const replacementHost = recordedClient(async () => ({ runId: 'never' }));
    const conversation = createCommittedHostConversation({
      client: lostHost.client,
      modelId: 'openrouter::anthropic/claude-sonnet-4.6',
      replacement: async () => replacementHost.client,
      threadId,
    });
    try {
      const sent = conversation.commands.onNew?.(message('Admitted before the loss'));
      lostHost.lose();
      loss.resolve();
      await expect(sent).resolves.toBeUndefined();
      expect(replacementHost.request.mock.calls.map(([method]) => method)).toEqual(['thread/read']);
    } finally {
      conversation.close();
    }
  });

  it('keeps an answered not-admitted refusal when the transport closes after its reply', async () => {
    const reason = new ThreadRootsRemovedError([{ displayName: 'bravo', rootId: 'r-bravo' }]);
    const failure = fromBoundaryResponseError(
      new ResponseError(HOST_RUN_NOT_ADMITTED_CODE, reason.message, reason.failure),
      vi.fn()
    );
    const answered = Promise.withResolvers<void>();
    const lostHost = recordedClient(async () => {
      await answered.promise;
      throw failure;
    });
    const replacement = vi.fn(async () => lostHost.client);
    const conversation = createCommittedHostConversation({
      client: lostHost.client,
      modelId: 'scripted',
      replacement,
      threadId,
    });
    try {
      const sent = conversation.commands.onNew?.(message('Refused before close'));
      lostHost.lose();
      answered.resolve();
      const cause: unknown = await sent?.catch((error: unknown) => error);
      expect(isMessageNotSentError(cause)).toBe(true);
      expect((cause as Error).message).toBe(describeBoundaryError(failure));
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      conversation.close();
    }
  });

  it('keeps a refusal from a live host as it is', async () => {
    const refusal = new Error('The model is not enabled');
    const liveHost = recordedClient(async () => {
      throw refusal;
    });
    const replacement = vi.fn(async () => liveHost.client);
    const conversation = createCommittedHostConversation({
      client: liveHost.client,
      modelId: 'openrouter::anthropic/claude-sonnet-4.6',
      replacement,
      threadId,
    });
    try {
      await expect(conversation.commands.onNew?.(message('Refused'))).rejects.toBe(refusal);
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      conversation.close();
    }
  });
});
