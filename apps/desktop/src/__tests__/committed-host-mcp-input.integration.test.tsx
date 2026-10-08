// @vitest-environment jsdom
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachAgentHost } from '@brainstrike/agent-host';
import type { HostClient } from '@brainstrike/agent-host/browser';
import { observeFixtureChild } from '@brainstrike/agent-host/test-fixtures/owned-process';
import { parseMcpElicitationPresentation } from '@brainstrike/assistant-contract';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { createCommittedHostConversation } from '../renderer/committed-host-conversation';
import { CommittedHostMcpInputView } from '../renderer/committed-host-mcp-input-view';

const Ready = z.object({
  input: z.object({ interactionId: z.string(), runId: z.string(), threadId: z.string() }),
  presentation: z.json(),
  record: z.json(),
  type: z.literal('ready'),
});
const resources = new Set<() => Promise<void>>();
afterEach(async () => {
  cleanup();
  const joined = await Promise.allSettled([...resources].map((close) => close()));
  const failures = joined.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'GUI fixture cleanup failed'
    );
  }
});
async function containsPrivateValue(root: string, secret: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && (await containsPrivateValue(path, secret))) {
      return true;
    }
    if (entry.isFile() && (await readFile(path)).includes(Buffer.from(secret))) {
      return true;
    }
  }
  return false;
}

/** Native Node owns the real host; jsdom renders the unchanged shipped consent controls. */
async function setup(signal: AbortSignal, mode: 'form' | 'url' = 'form', unknown = false) {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-gui-'));
  const secret = `synthetic-private-${randomUUID()}`;
  const child = fork(join(import.meta.dirname, 'fixtures', 'committed-host-mcp-gui.mjs'), [], {
    env: { BRAINSTRIKE_DISABLE_FILE_LOGS: '1', PATH: process.env['PATH'] },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const observed = observeFixtureChild(child, (pid) => {
    const start = processStartTime(pid);
    if (!start) {
      throw new Error('GUI fixture process identity is unavailable');
    }
    return { executable: process.execPath, pid, start };
  });
  const ready = Promise.withResolvers<z.output<typeof Ready>>();
  ready.promise.catch(() => undefined);
  const delivered: unknown[] = [];
  child.on('message', (message: unknown) => {
    const parsed = Ready.safeParse(message);
    if (parsed.success) {
      ready.resolve(parsed.data);
      return;
    }
    const delivery = z
      .object({ answer: z.json(), type: z.literal('delivered') })
      .safeParse(message);
    if (delivery.success) {
      delivered.push(delivery.data.answer);
      return;
    }
    const failure = z
      .object({ message: z.string(), type: z.enum(['failed', 'cleanup-failed']) })
      .safeParse(message);
    if (failure.success) {
      ready.reject(new Error(failure.data.message));
    }
  });
  observed.done.then(
    () => ready.reject(new Error('GUI host exited before readiness')),
    ready.reject
  );
  const aborted = (): void => ready.reject(signal.reason);
  signal.addEventListener('abort', aborted, { once: true });
  let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', aborted);
      if (child.connected) {
        child.send({ type: 'stop' });
      }
      const exited = await observed.done;
      const clientJoined = await Promise.allSettled([client?.close()]);
      const failures = clientJoined.filter((result) => result.status === 'rejected');
      if (exited.code !== 0 || exited.signal || failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          `GUI host did not join: ${JSON.stringify(exited)} ${observed.output.stderr()}`
        );
      }
      const guard = await RootLock.acquire(root);
      guard.release();
      if (await containsPrivateValue(root, secret)) {
        throw new Error('Private GUI input reached durable Root bytes');
      }
      await rm(root, { force: true, recursive: true });
      resources.delete(close);
    })());
  resources.add(close);
  child.send({ mode, root, secret, type: 'start', unknown });
  const data = await ready.promise;
  client = await attachAgentHost(decodeHostRecord(data.record));
  return {
    client,
    close,
    delivered,
    input: data.input,
    presentation: parseMcpElicitationPresentation(data.presentation),
    record: decodeHostRecord(data.record),
    root,
    secret,
  };
}

test('the shipped conversation shows an actual Core form and commits one decision before native delivery', async ({
  signal,
}) => {
  const owned = await setup(signal);
  const conversation = createCommittedHostConversation({
    client: owned.client,
    modelId: 'scripted',
    threadId: owned.input.threadId,
  });
  try {
    expect(conversation.mcpInput).toBeDefined();
    await act(async () => {
      await expect
        .poll(() => conversation.mcpInput.getSnapshot().input?.presentation)
        .toBeDefined();
    });
    render(<CommittedHostMcpInputView input={conversation.mcpInput} />);
    const screen = within(document.body);
    await screen.findByRole('dialog');
    const accept = screen.getByRole('button', {
      name: 'Accept and send input to recorded.gui.server',
    });
    fireEvent.click(accept);
    expect(owned.delivered).toEqual([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace' }), {
      target: { value: owned.secret },
    });
    await act(async () => {
      fireEvent.click(accept);
      fireEvent.click(accept);
      await expect.poll(() => owned.delivered.length).toBe(1);
      await expect
        .poll(async () => (await owned.client.request('mcp/input/read', owned.input)).status)
        .toBe('local-finalized');
      await finished(owned);
    });
    expect(owned.delivered).toEqual([
      expect.objectContaining({ action: 'accept', content: { workspace: owned.secret } }),
    ]);
    const { rows } = await owned.client.request('thread/read', {
      fromSeq: 0,
      threadId: owned.input.threadId,
    });
    expect(rows.filter(({ event }) => event.type === 'mcp.input.intent')).toHaveLength(1);
    expect(rows.filter(({ event }) => event.type === 'mcp.input.settled')).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(owned.secret);
  } finally {
    conversation.close();
    cleanup();
    // Join this view's queued subscribe/unsubscribe before retiring the socket owner.
    await owned.client.request('thread/read', { fromSeq: 0, threadId: owned.input.threadId });
    await owned.close();
  }
});

async function finished(owned: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await expect
    .poll(async () =>
      (
        await owned.client.request('thread/read', { fromSeq: 0, threadId: owned.input.threadId })
      ).rows.some(({ event }) => event.type === 'run.finished')
    )
    .toBe(true);
}
async function openView(owned: Awaited<ReturnType<typeof setup>>, client = owned.client) {
  const conversation = createCommittedHostConversation({
    client,
    modelId: 'scripted',
    threadId: owned.input.threadId,
  });
  await act(async () => {
    await expect.poll(() => conversation.mcpInput.getSnapshot().input?.presentation).toBeDefined();
  });
  render(<CommittedHostMcpInputView input={conversation.mcpInput} />);
  return conversation;
}
async function releaseView(
  conversation: ReturnType<typeof createCommittedHostConversation>,
  owned: Awaited<ReturnType<typeof setup>>
) {
  conversation.close();
  cleanup();
  await owned.client.request('thread/read', { fromSeq: 0, threadId: owned.input.threadId });
  await owned.close();
}

test.for(['accept', 'decline', 'cancel'] as const)(
  'URL consent delivers only the explicit %s action without durable capability bytes',
  async (action, { signal }) => {
    const owned = await setup(signal, 'url');
    const conversation = await openView(owned);
    try {
      const screen = within(document.body);
      expect(screen.getByTestId('mcp-elicitation-url').textContent).toBe(
        `https://example.test/${owned.secret}`
      );
      expect(owned.delivered).toEqual([]);
      const label =
        action === 'accept'
          ? 'Accept and open link from recorded.gui.server'
          : `${action === 'decline' ? 'Decline' : 'Cancel'} MCP request from recorded.gui.server`;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: label }));
        await expect.poll(() => owned.delivered.length).toBe(1);
        await finished(owned);
      });
      expect(owned.delivered).toEqual([expect.objectContaining({ action })]);
      expect(owned.delivered[0]).not.toHaveProperty('content');
      const { rows } = await owned.client.request('thread/read', {
        fromSeq: 0,
        threadId: owned.input.threadId,
      });
      expect(rows.filter(({ event }) => event.type === 'mcp.input.intent')).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(owned.secret);
    } finally {
      await releaseView(conversation, owned);
    }
  }
);

test('Stop retires a visible private form and joins the parked native caller', async ({
  signal,
}) => {
  const owned = await setup(signal);
  const conversation = await openView(owned);
  try {
    expect(within(document.body).getByRole('dialog')).toBeDefined();
    const onCancel = conversation.commands.onCancel;
    if (!onCancel) {
      throw new Error('The committed conversation has no Stop command');
    }
    await act(async () => {
      await onCancel();
      await finished(owned);
    });
    expect(conversation.mcpInput.getSnapshot().input?.status).toBe('retired');
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(owned.delivered).toEqual([]);
    expect((await owned.client.request('mcp/input/read', owned.input)).status).toBe('retired');
    fireEvent.click(within(document.body).getByRole('button', { name: 'Dismiss' }));
    expect(conversation.mcpInput.getSnapshot().input).toBeUndefined();
  } finally {
    await releaseView(conversation, owned);
  }
});

test('disconnect removes consent and a new attached view rereads only the still-live private capability', async ({
  signal,
}) => {
  const owned = await setup(signal);
  let conversation = await openView(owned);
  let reader: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  try {
    await act(async () => {
      await owned.client.close();
    });
    expect(conversation.mcpInput.getSnapshot().connected).toBe(false);
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(owned.delivered).toEqual([]);
    conversation.close();
    cleanup();
    reader = await attachAgentHost(owned.record);
    conversation = await openView(owned, reader);
    expect(within(document.body).getByRole('dialog')).toBeDefined();
    await act(async () => {
      fireEvent.click(
        within(document.body).getByRole('button', {
          name: 'Decline MCP request from recorded.gui.server',
        })
      );
      await expect.poll(() => owned.delivered.length).toBe(1);
      await expect
        .poll(async () => (await reader?.request('mcp/input/read', owned.input))?.status)
        .toBe('local-finalized');
    });
    expect(owned.delivered).toEqual([expect.objectContaining({ action: 'decline' })]);
  } finally {
    conversation.close();
    cleanup();
    if (reader) {
      await reader.request('thread/read', { fromSeq: 0, threadId: owned.input.threadId });
      await reader.close();
    }
    await owned.close();
  }
});

test('unknown native delivery remains visible after reopening and never presents or sends another decision', async ({
  signal,
}) => {
  const owned = await setup(signal, 'form', true);
  let conversation = await openView(owned);
  try {
    const screen = within(document.body);
    fireEvent.change(screen.getByRole('textbox', { name: 'Workspace' }), {
      target: { value: owned.secret },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Accept and send input to recorded.gui.server' })
      );
      await expect
        .poll(async () => (await owned.client.request('mcp/input/read', owned.input)).status)
        .toBe('unknown');
      await finished(owned);
    });
    expect(conversation.mcpInput.getSnapshot().input?.status).toBe('unknown');
    expect(screen.queryByRole('dialog')).toBeNull();
    conversation.close();
    cleanup();
    conversation = createCommittedHostConversation({
      client: owned.client,
      modelId: 'scripted',
      threadId: owned.input.threadId,
    });
    await act(async () => {
      await expect.poll(() => conversation.mcpInput.getSnapshot().input?.status).toBe('unknown');
    });
    render(<CommittedHostMcpInputView input={conversation.mcpInput} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();
    expect(owned.delivered).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(conversation.mcpInput.getSnapshot().input).toBeUndefined();
    const { rows } = await owned.client.request('thread/read', {
      fromSeq: 0,
      threadId: owned.input.threadId,
    });
    expect(rows.filter(({ event }) => event.type === 'mcp.input.intent')).toHaveLength(1);
    expect(rows.filter(({ event }) => event.type === 'mcp.input.settled')).toHaveLength(1);
  } finally {
    await releaseView(conversation, owned);
  }
});

test.for([true, false])(
  'a lost settlement reply never resends; committed final facts remain authoritative (unknown=%s)',
  async (unknown, { signal }) => {
    const owned = await setup(signal, 'form', unknown);
    let commands = 0;
    const request: HostClient['request'] = (method, params) => {
      const result = owned.client.request(method, params);
      if (method !== 'mcp/input/settle') {
        return result;
      }
      commands += 1;
      return result.then(() => {
        throw new Error('Recorded settlement reply lost');
      });
    };
    const conversation = await openView(owned, { ...owned.client, request });
    try {
      const screen = within(document.body);
      fireEvent.change(screen.getByRole('textbox', { name: 'Workspace' }), {
        target: { value: owned.secret },
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Accept and send input to recorded.gui.server' })
        );
        await expect.poll(() => owned.delivered.length).toBe(1);
        await finished(owned);
        await expect
          .poll(() => conversation.mcpInput.getSnapshot().input?.status)
          .toBe(unknown ? 'unknown' : undefined);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      const origin = owned.presentation.provenance;
      await expect(
        conversation.mcpInput.settle({
          action: 'accept',
          configuredServerId: origin.configuredServerId,
          content: { workspace: owned.secret },
          generation: origin.generation,
          id: owned.input.interactionId,
          requestId: origin.requestId,
        })
      ).rejects.toThrow();
      expect(commands).toBe(1);
      expect(owned.delivered).toHaveLength(1);
      expect((await owned.client.request('mcp/input/read', owned.input)).status).toBe(
        unknown ? 'unknown' : 'local-finalized'
      );
    } finally {
      await releaseView(conversation, owned);
    }
  }
);
