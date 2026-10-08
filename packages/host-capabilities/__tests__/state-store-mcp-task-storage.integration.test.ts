// The PGlite McpTaskRepository's behaviour cases, on the host StateStore's
// Tasks tables through its one writer (BST-1930 ruling B).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type McpTaskAuthorityLease,
  McpTaskMetadataTooLargeError,
  McpTaskStore,
} from '@brainstrike/db';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, describe, expect, it } from 'vitest';
import { stateStoreMcpTaskStorage } from '../src/mcp/state-store-task-storage.js';

const authorityInput = {
  connectionGeneration: 7,
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  runtimeId: 'desktop-runtime-a',
  serverId: 'linear',
} as const;

function identity(authority: McpTaskAuthorityLease, taskId = 'task-1') {
  return {
    authorityEpoch: authority.authorityEpoch,
    principalId: authority.principalId,
    resource: authority.resource,
    serverId: authority.serverId,
    taskId,
  } as const;
}

describe('McpTaskStore over the host StateStore', () => {
  const roots: string[] = [];
  const stores = new Set<StateStore>();

  async function open(root?: string): Promise<{ root: string; store: StateStore }> {
    const selected = root ?? (await mkdtemp(join(tmpdir(), 'bs-mcp-task-store-')));
    if (!root) {
      roots.push(selected);
    }
    const store = await StateStore.open(selected);
    stores.add(store);
    return { root: selected, store };
  }

  async function close(store: StateStore): Promise<void> {
    stores.delete(store);
    await store.close();
  }

  function tasks(store: StateStore, now?: () => Date): McpTaskStore {
    return new McpTaskStore(stateStoreMcpTaskStorage(store), now);
  }

  afterEach(async () => {
    for (const store of stores) {
      await store.close();
    }
    stores.clear();
    for (const root of roots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('persists a principal-bound task across a host restart', async () => {
    const first = await open();
    const repository = tasks(first.store);
    const authority = await repository.openAuthority(authorityInput);
    const created = await repository.create(
      { ...identity(authority), inputMetadata: { prompt: 'choose' }, status: 'input_required' },
      authority
    );
    expect(created).toMatchObject({ ...identity(authority), status: 'input_required' });
    await close(first.store);

    const reopened = await open(first.root);
    await expect(tasks(reopened.store).get(identity(authority))).resolves.toEqual(created);
  });

  it('rebinds the live durable authority across restart without resurrecting a retired epoch', async () => {
    const opened = await open();
    let repository = tasks(opened.store);
    const first = await repository.openAuthority(authorityInput);
    await repository.create({ ...first, status: 'working', taskId: 'before-restart' }, first);
    await close(opened.store);

    let reopened = await open(opened.root);
    repository = tasks(reopened.store);
    const rebound = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 1,
      runtimeId: 'desktop-runtime-b',
    });
    expect(rebound.authorityEpoch).toBe(first.authorityEpoch);
    await expect(repository.listActive(first)).resolves.toEqual([]);
    await expect(repository.listActive(rebound)).resolves.toMatchObject([
      { authorityEpoch: first.authorityEpoch, taskId: 'before-restart' },
    ]);
    const replacement = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 2,
      runtimeId: 'desktop-runtime-b',
    });
    expect(replacement.authorityEpoch).not.toBe(first.authorityEpoch);
    await expect(
      repository.openAuthority({
        ...authorityInput,
        connectionGeneration: 1,
        runtimeId: 'desktop-runtime-b',
      })
    ).rejects.toThrow(/acquisition is stale/u);
    await expect(repository.listActive(replacement)).resolves.toEqual([]);
    await repository.create(
      { ...replacement, status: 'working', taskId: 'after-replacement' },
      replacement
    );
    await close(reopened.store);

    reopened = await open(opened.root);
    repository = tasks(reopened.store);
    const secondRebound = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 1,
      runtimeId: 'desktop-runtime-c',
    });
    expect(secondRebound.authorityEpoch).toBe(replacement.authorityEpoch);
    await expect(repository.listActive(secondRebound)).resolves.toMatchObject([
      { authorityEpoch: replacement.authorityEpoch, taskId: 'after-replacement' },
    ]);
    await expect(
      repository.update({ ...first, taskId: 'before-restart' }, { status: 'working' }, first)
    ).rejects.toThrow(/missing or stale/u);
  });

  it('updates metadata, bounds history, and makes terminal state immutable', async () => {
    const { store } = await open();
    let tick = 0;
    const repository = tasks(store, () => new Date(Date.UTC(2026, 7, 31, 20, 0, tick++)));
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    for (let index = 0; index < 35; index += 1) {
      await repository.update(
        taskIdentity,
        { inputMetadata: { index }, status: index % 2 === 0 ? 'input_required' : 'working' },
        authority
      );
    }
    const terminal = await repository.update(
      taskIdentity,
      { resultMetadata: { answer: 42 }, status: 'completed' },
      authority
    );
    expect(terminal.history).toHaveLength(32);
    expect(terminal.inputMetadata).toEqual({ index: 34 });
    expect(terminal.resultMetadata).toEqual({ answer: 42 });
    expect(terminal.terminalAt).toEqual(terminal.updatedAt);
    await expect(
      repository.update(taskIdentity, { status: 'cancelled' }, authority)
    ).rejects.toThrow(/immutable/u);
  });

  it('rejects stale writes and isolates server, principal, resource, and authority epoch', async () => {
    const { store } = await open();
    const repository = tasks(store);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    for (const changed of [
      { serverId: 'other' },
      { principalId: 'other' },
      { resource: 'https://example.com/mcp' },
      { authorityEpoch: '00000000-0000-7000-8000-000000000000' },
    ]) {
      await expect(repository.get({ ...taskIdentity, ...changed })).resolves.toBeNull();
    }
    const replacement = await repository.openAuthority({
      ...authorityInput,
      connectionGeneration: 8,
    });
    await expect(repository.update(taskIdentity, { status: 'working' }, authority)).rejects.toThrow(
      /missing or stale/u
    );
    await expect(
      repository.create({ ...taskIdentity, status: 'working', taskId: 'stale-task' }, authority)
    ).rejects.toThrow(/missing or stale/u);
    await expect(
      repository.create(
        { ...identity(replacement, 'replacement-task'), status: 'working' },
        replacement
      )
    ).resolves.toMatchObject({ authorityEpoch: replacement.authorityEpoch });
    await expect(
      repository.update(taskIdentity, { status: 'working' }, replacement)
    ).rejects.toThrow(/does not match/u);
  });

  it('enforces merged input and result metadata before their statuses', async () => {
    const { store } = await open();
    const repository = tasks(store);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    await expect(
      repository.update(taskIdentity, { status: 'input_required' }, authority)
    ).rejects.toThrow(TypeError);
    await expect(
      repository.update(taskIdentity, { status: 'completed' }, authority)
    ).rejects.toThrow(TypeError);
    await repository.update(
      taskIdentity,
      { inputMetadata: { prompt: 'choose' }, resultMetadata: { answer: 42 }, status: 'working' },
      authority
    );
    await expect(
      repository.update(taskIdentity, { status: 'input_required' }, authority)
    ).resolves.toMatchObject({ inputMetadata: { prompt: 'choose' }, status: 'input_required' });
    await expect(
      repository.update(taskIdentity, { status: 'completed' }, authority)
    ).resolves.toMatchObject({ resultMetadata: { answer: 42 }, status: 'completed' });
  });

  it('bounds listActive deterministically to one live scope', async () => {
    const { store } = await open();
    const repository = tasks(store);
    const authority = await repository.openAuthority(authorityInput);
    for (const taskId of ['b-task', 'a-task', 'c-task']) {
      await repository.create({ ...identity(authority, taskId), status: 'working' }, authority);
    }
    await repository.create(
      { ...identity(authority, 'done'), resultMetadata: { answer: 42 }, status: 'completed' },
      authority
    );
    const other = await repository.openAuthority({ ...authorityInput, principalId: 'other' });
    await repository.create({ ...identity(other, 'other-task'), status: 'working' }, other);
    await expect(repository.listActive(authority, { limit: 2 })).resolves.toHaveLength(2);
    const all = await repository.listActive(authority);
    expect(all.map(({ taskId }) => taskId).sort()).toEqual(['a-task', 'b-task', 'c-task']);
    await expect(repository.listActive(authority, { limit: 0 })).rejects.toThrow(TypeError);
  });

  it('refuses oversized stored metadata with its size and digest', async () => {
    const { store } = await open();
    const repository = tasks(store);
    const authority = await repository.openAuthority(authorityInput);
    const taskIdentity = identity(authority);
    await repository.create({ ...taskIdentity, status: 'working' }, authority);
    const failure = repository.update(
      taskIdentity,
      { inputMetadata: { text: 'x'.repeat(70_000) }, status: 'working' },
      authority
    );
    await expect(failure).rejects.toBeInstanceOf(McpTaskMetadataTooLargeError);
    await expect(failure).rejects.toMatchObject({
      field: 'inputMetadata',
      maxBytes: 65_536,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('binds a task to the host thread that created it, and to no other', async () => {
    const { store } = await open();
    await store.append([{ event: { type: 'thread.started' }, threadId: 'thread-a' }]);
    const repository = tasks(store);
    const authority = await repository.openAuthority(authorityInput);
    await expect(
      repository.create(
        { ...identity(authority, 'bound'), status: 'working', threadId: 'thread-a' },
        authority
      )
    ).resolves.toMatchObject({ taskId: 'bound' });
    await expect(
      repository.create(
        { ...identity(authority, 'orphan'), status: 'working', threadId: 'missing-thread' },
        authority
      )
    ).rejects.toThrow(/FOREIGN KEY/u);
    await expect(repository.get(identity(authority, 'orphan'))).resolves.toBeNull();
  });
});
