import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, RootLockedError } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import type { HostPlatform } from '../src/ports.js';
import { scriptedModel } from './fixtures/scripted-model.js';

async function cleanup(
  client: HostClient | undefined,
  host: AgentHost | undefined,
  root: string
): Promise<void> {
  await client?.close();
  await host?.close();
  if (RootLock.inspect(root)?.owner.released) {
    await rm(root, { recursive: true });
  }
}

test('public socket Watch updates persist in the existing Core log across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  const platform: HostPlatform = {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  };
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const command = { commandId: randomUUID(), patch: { forgePrWatch: false }, threadId };
    expect(await client.request('thread/workspace/binding/update', command)).toEqual({
      accepted: true,
    });
    const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(before.filter(({ event }) => event.type === 'workspace.binding.updated')).toHaveLength(
      1
    );
    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: { forgePrWatch: false },
    });
    await client.request('thread/workspace/binding/update', command);
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(before);
  } finally {
    await cleanup(client, host, root);
  }
});

test('the borrowed validator gates socket binding commands and worktree transitions across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  // Controlled port proof: these IDs never come from the view-only workspace snapshot.
  // Actual Main catalog/worktree qualification is a separate integration boundary.
  const rootId = randomUUID();
  const validations: string[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    validateWorkspaceBinding: async ({ binding, signal }) => {
      signal.throwIfAborted();
      if (binding.operatingRootId !== rootId) {
        throw new Error('The existing root owner rejected the binding');
      }
      validations.push(binding.operatingRootId);
    },
  };
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: null,
    });
    const patch = {
      checkoutBranch: 'topic',
      checkoutLocalRootId: rootId,
      checkoutMode: 'worktree' as const,
      checkoutWorktreeId: randomUUID(),
      checkoutWorktreePath: join(root, 'worktree-display-hint'),
      forgePrUrl: 'https://github.com/seandearnaley/brainstrike/pull/3543',
      forgePrWatch: false,
      operatingRootDisplayName: 'Controlled catalog workspace',
      operatingRootId: rootId,
      secondaryRootIds: [],
    };
    const request = { commandId: randomUUID(), patch, threadId };
    const published: unknown[] = [];
    const active = host;
    const release = host.core.onCommitted((row) => {
      if (row.event.type === 'workspace.binding.updated') {
        published.push(active.core.readWorkspaceBinding(threadId).binding);
      }
    });
    expect(await client.request('thread/workspace/binding/update', request)).toEqual({
      accepted: true,
    });
    expect(published).toEqual([patch]);
    const committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(
      committed.filter(({ event }) => event.type === 'workspace.binding.updated')
    ).toHaveLength(1);
    await client.request('thread/workspace/binding/update', request);
    expect(validations).toEqual([rootId]);
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(committed);
    const local = { commandId: randomUUID(), patch: { checkoutMode: 'local' as const }, threadId };
    await client.request('thread/workspace/binding/update', local);
    const {
      checkoutBranch: _branch,
      checkoutLocalRootId: _local,
      checkoutWorktreeId: _worktree,
      checkoutWorktreePath: _path,
      ...remaining
    } = patch;
    const expected = { ...remaining, checkoutMode: 'local' };
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: expected,
    });
    release();
    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: expected,
    });
    await client.request('thread/workspace/binding/update', local);
    expect(validations).toEqual([rootId, rootId]);
    const view = host.core.readWorkspaceBinding(threadId).binding;
    view?.secondaryRootIds?.push('view-only');
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: expected,
    });
  } finally {
    await cleanup(client, host, root);
  }
});

test('missing or rejected live scope authority cannot append a binding while Watch remains an owned preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      }
    );
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    await expect(
      client.request('thread/workspace/binding/update', {
        commandId: randomUUID(),
        patch: { operatingRootDisplayName: 'Unknown', operatingRootId: randomUUID() },
        threadId,
      })
    ).rejects.toThrow();
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(before);
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { forgePrWatch: false },
      threadId,
    });
    expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
      binding: { forgePrWatch: false },
    });
  } finally {
    await cleanup(client, host, root);
  }
});

test('Root close cancels but joins the original held binding validation before lease release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  const entered = Promise.withResolvers<AbortSignal>();
  const physical = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let retired = false;
  let committedBindings = 0;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        close: async () => {
          expect(retired).toBe(true);
        },
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
        validateWorkspaceBinding: async ({ signal }) => {
          signal.addEventListener('abort', () => aborted.resolve(), { once: true });
          entered.resolve(signal);
          await physical.promise;
          retired = true;
        },
      }
    );
    client = await attachAgentHost(host.record);
    host.core.onCommitted(({ event }) => {
      if (event.type === 'workspace.binding.updated') {
        committedBindings++;
      }
    });
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const original = client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Held', operatingRootId: randomUUID() },
      threadId,
    });
    const outcome = original.then(
      () => 'accepted',
      () => 'refused'
    );
    const signal = await entered.promise;
    const closing = host.close();
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    expect(retired).toBe(false);
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
    physical.resolve();
    expect(await outcome).toBe('refused');
    await closing;
    expect(retired).toBe(true);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    expect(committedBindings).toBe(0);
  } finally {
    physical.resolve();
    await cleanup(client, host, root);
  }
});

test.each([
  { reopen: false, revoke: false },
  { reopen: false, revoke: true },
  { reopen: true, revoke: false },
  { reopen: true, revoke: true },
])(
  'pending run retains its committed binding and fences revocation=$revoke after reopen=$reopen',
  async ({ reopen, revoke }) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
    const originalId = randomUUID();
    const nextId = randomUUID();
    const live = new Set<string>([originalId, nextId]);
    const effects: string[] = [];
    const selections: string[] = [];
    const binding = {
      operatingRootDisplayName: 'Original catalog root',
      operatingRootId: originalId,
    };
    const platform: HostPlatform = {
      admitRun: async (request) => {
        const id = request.workspaceBinding?.operatingRootId;
        if (!id) {
          throw new Error('Core did not forward its operating-root binding');
        }
        selections.push(id);
        return {
          configuration: { boundWorkspaceRootId: id },
          model: scriptedModel('edit'),
          snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { edit: 'controlled-edit' } },
          tools: {
            edit: {
              description: 'Existing SDK edit shape with a controlled root owner',
              execute: async () => {
                effects.push(id);
                return { written: true };
              },
              identity: 'controlled-edit',
              inputSchema: z.object({ text: z.string() }),
              risk: 'edit',
            },
          },
        };
      },
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      validateWorkspaceBinding: async ({ binding: captured, signal }) => {
        signal.throwIfAborted();
        if (!(captured.operatingRootId && live.has(captured.operatingRootId))) {
          throw new Error('The captured root was revoked');
        }
      },
    };
    let host: AgentHost | undefined;
    let client: HostClient | undefined;
    try {
      host = await startAgentHost({ lifetime: 'persistent', root }, platform);
      client = await attachAgentHost(host.record);
      const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
      await client.request('thread/workspace/binding/update', {
        commandId: randomUUID(),
        patch: binding,
        threadId,
      });
      const { runId } = await client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Edit',
        threadId,
      });
      const active = client;
      await expect
        .poll(async () =>
          (await active.request('thread/read', { fromSeq: 0, threadId })).rows.some(
            ({ event }) => event.type === 'interaction.requested'
          )
        )
        .toBe(true);
      const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      const pending = before
        .map(({ event }) => event)
        .find((event) => event.type === 'interaction.requested');
      if (!pending) {
        throw new Error('The actual SDK did not reach its committed edit decision');
      }
      const started = before
        .map(({ event }) => event)
        .find((event) => event.type === 'run.started');
      expect(started?.snapshot?.workspaceBinding).toEqual(binding);
      const next = { operatingRootDisplayName: 'Next catalog root', operatingRootId: nextId };
      await client.request('thread/workspace/binding/update', {
        commandId: randomUUID(),
        patch: next,
        threadId,
      });
      if (reopen) {
        await client.close();
        client = undefined;
        await host.close();
        host = undefined;
      }
      if (revoke) {
        live.delete(originalId);
      }
      if (reopen) {
        host = await startAgentHost({ lifetime: 'persistent', root }, platform);
        client = await attachAgentHost(host.record);
      }
      if (!client) {
        throw new Error('The retained or reopened socket client is unavailable');
      }
      expect(await client.request('thread/workspace/binding/read', { threadId })).toEqual({
        binding: next,
      });
      const response = {
        commandId: randomUUID(),
        decision: 'approve' as const,
        interactionId: pending.interactionId,
        runId,
        threadId,
      };
      if (revoke) {
        const committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
        await expect(client.request('interaction/respond', response)).rejects.toThrow();
        expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(
          committed
        );
      } else {
        await client.request('interaction/respond', response);
        const recovered = client;
        await expect
          .poll(async () => {
            const terminal = (await recovered.request('thread/read', { fromSeq: 0, threadId })).rows
              .map(({ event }) => event)
              .find((event) => event.type === 'run.finished');
            return terminal?.outcome;
          })
          .toBe('completed');
      }
      expect(effects).toEqual(revoke ? [] : [originalId]);
      expect(selections).toEqual(reopen && !revoke ? [originalId, originalId] : [originalId]);
    } finally {
      await cleanup(client, host, root);
    }
  }
);

test('an adapter that drops the committed operating root is joined before admission is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  let closedSelections = 0;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        admitRun: async () => ({
          close: async () => {
            closedSelections++;
          },
          configuration: {},
          model: scriptedModel(),
          snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
          tools: {},
        }),
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
        validateWorkspaceBinding: async ({ signal }) => signal.throwIfAborted(),
      }
    );
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Owner root', operatingRootId: randomUUID() },
      threadId,
    });
    const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    await expect(
      client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Run',
        threadId,
      })
    ).rejects.toThrow();
    expect(closedSelections).toBe(1);
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(before);
  } finally {
    await cleanup(client, host, root);
  }
});

test('a root revoked while its existing admission is held cannot commit run acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  const rootId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let live = true;
  let closedSelections = 0;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        admitRun: async () => {
          entered.resolve();
          await release.promise;
          return {
            close: async () => {
              closedSelections++;
            },
            configuration: { boundWorkspaceRootId: rootId },
            model: scriptedModel(),
            snapshot: { configuration: {}, maxSteps: 3, toolIdentities: {} },
            tools: {},
          };
        },
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
        validateWorkspaceBinding: async ({ signal }) => {
          signal.throwIfAborted();
          if (!live) {
            throw new Error('The existing captured root is unavailable');
          }
        },
      }
    );
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Captured owner root', operatingRootId: rootId },
      threadId,
    });
    const before = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    const starting = client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Run',
      threadId,
    });
    const refusal = expect(starting).rejects.toThrow();
    await entered.promise;
    live = false;
    release.resolve();
    await refusal;
    expect(closedSelections).toBe(1);
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(before);
  } finally {
    release.resolve();
    await cleanup(client, host, root);
  }
});

test('revocation during the final permission read prevents the admitted executor and effect append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-binding-'));
  const rootId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let live = true;
  let holdPolicy = false;
  let executed = 0;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost(
      { lifetime: 'persistent', root },
      {
        admitRun: async () => ({
          configuration: { boundWorkspaceRootId: rootId },
          model: scriptedModel('edit'),
          snapshot: { configuration: {}, maxSteps: 3, toolIdentities: { edit: 'controlled-edit' } },
          tools: {
            edit: {
              description: 'Existing recorded SDK call through a controlled live owner',
              execute: async () => {
                executed++;
                return { written: true };
              },
              identity: 'controlled-edit',
              inputSchema: z.object({ text: z.string() }),
              risk: 'edit',
            },
          },
        }),
        close: async () => undefined,
        readPermissionPolicy: async () => {
          if (holdPolicy) {
            entered.resolve();
            await release.promise;
          }
          return { policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false };
        },
        validateWorkspaceBinding: async ({ signal }) => {
          signal.throwIfAborted();
          if (!live) {
            throw new Error('The captured root was revoked');
          }
        },
      }
    );
    client = await attachAgentHost(host.record);
    host.core.onCommitted(({ event }) => {
      if (event.type === 'interaction.responded') {
        holdPolicy = true;
      }
    });
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Captured owner root', operatingRootId: rootId },
      threadId,
    });
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Edit',
      threadId,
    });
    const active = client;
    await expect
      .poll(async () =>
        (await active.request('thread/read', { fromSeq: 0, threadId })).rows.some(
          ({ event }) => event.type === 'interaction.requested'
        )
      )
      .toBe(true);
    const pending = (await client.request('thread/read', { fromSeq: 0, threadId })).rows
      .map(({ event }) => event)
      .find((event) => event.type === 'interaction.requested');
    if (!pending) {
      throw new Error('The recorded SDK call did not reach a committed approval');
    }
    await client.request('interaction/respond', {
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: pending.interactionId,
      runId,
      threadId,
    });
    await entered.promise;
    live = false;
    release.resolve();
    await expect
      .poll(
        async () =>
          (await active.request('thread/read', { fromSeq: 0, threadId })).rows
            .map(({ event }) => event)
            .find((event) => event.type === 'run.finished')?.outcome
      )
      .toBe('completed');
    const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(executed).toBe(0);
    expect(rows.filter(({ event }) => event.type === 'effect.started')).toEqual([]);
    const messages = rows.flatMap(({ event }) =>
      event.type === 'model.messages' ? event.messages : []
    );
    expect(messages).toContainEqual({
      content: expect.arrayContaining([
        {
          output: expect.objectContaining({ type: 'error-text' }),
          toolCallId: pending.toolCallId,
          toolName: pending.toolId,
          type: 'tool-result',
        },
      ]),
      role: 'tool',
    });
  } finally {
    release.resolve();
    await cleanup(client, host, root);
  }
});
