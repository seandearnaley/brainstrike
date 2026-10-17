/**
 * A host's catalog as the shell's thread list shows it, and a thread's
 * workspace snapshot through its owning host (BST-1940): shared by desktop's
 * and the web's thread hosts.
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  EMPTY_WORKSPACE_SNAPSHOT,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import { projectHostThread, projectStartedHostThread } from '../host-thread-catalog';
import { hostThreadWorkspaceRepository } from '../host-thread-workspace';

const RESOURCE = WORKSPACE_MEMORY_RESOURCE_ID;

describe("a host's catalog, as the thread list shows it", () => {
  it('shows the committed title, colour, icon and binding, and the damage of a thread it cannot read', () => {
    expect(
      projectHostThread(RESOURCE, {
        binding: { operatingRootId: 'root-1' },
        color: 'blue',
        createdAt: 1,
        damage: 'Row 4 failed its crc',
        icon: 'kestrel-unknown',
        threadId: 'thread-1',
        title: 'Kestrel',
        updatedAt: 2,
      })
    ).toEqual({
      createdAt: new Date(1),
      id: 'thread-1',
      // An icon this renderer cannot draw is left out.
      metadata: { color: 'blue', operatingRootId: 'root-1' },
      readFailure: 'Row 4 failed its crc',
      resourceId: RESOURCE,
      title: 'Kestrel',
      updatedAt: new Date(2),
    });
  });

  it('names an untitled thread with the default title, and dates a new one from its start', () => {
    const started = projectStartedHostThread('thread-2', RESOURCE, [
      { event: { commandId: 'c', type: 'thread.started' }, seq: 2, threadId: 'thread-2', ts: 7 },
    ]);
    expect(started).toMatchObject({
      createdAt: new Date(7),
      id: 'thread-2',
      updatedAt: new Date(7),
    });
    expect(started.title).not.toBe('');
    expect(() => projectStartedHostThread('thread-3', RESOURCE, [])).toThrow(
      'Host thread has no committed creation timestamp'
    );
  });
});

describe("a thread's workspace snapshot, through its owning host", () => {
  function owningHost() {
    const sent: { readonly method: string; readonly params: unknown }[] = [];
    const host = {
      request: (async (method: string, params: unknown) => {
        sent.push({ method, params });
        return method === 'thread/workspace/read' ? { snapshot: null } : { accepted: true };
      }) as HostClient['request'],
    };
    return { host, sent };
  }

  it('reads and saves an owned thread workspace through its host, and refuses a thread no host owns', async () => {
    const { host, sent } = owningHost();
    const repository = hostThreadWorkspaceRepository(async (threadId) =>
      threadId === 'owned' ? host : undefined
    );

    expect(await repository.getThreadWorkspace('owned')).toBeNull();
    await repository.setThreadWorkspace('owned', RESOURCE, EMPTY_WORKSPACE_SNAPSHOT);
    expect(sent.at(-1)).toEqual({
      method: 'thread/workspace/set',
      params: {
        commandId: expect.any(String),
        snapshot: EMPTY_WORKSPACE_SNAPSHOT,
        threadId: 'owned',
      },
    });
    await expect(repository.getThreadWorkspace('elsewhere')).rejects.toThrow(
      'This workspace snapshot is not owned by the attached agent host.'
    );
    await expect(
      repository.setThreadWorkspace('owned', 'another-resource', EMPTY_WORKSPACE_SNAPSHOT)
    ).rejects.toThrow('The host thread belongs to the workspace resource');
  });
});
