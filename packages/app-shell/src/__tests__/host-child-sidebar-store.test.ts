import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantThreadHostChild } from '../assistant-thread-host-context';
import { HostChildSidebarStore } from '../host-child-sidebar-store';

function child(
  threadId: string,
  status: AssistantThreadHostChild['status']
): AssistantThreadHostChild {
  return {
    callSign: `Cedar-${threadId}`,
    color: 'family:2000:730',
    depth: 1,
    parentRunId: 'root-run',
    parentThreadId: 'root-1',
    persona: 'worker',
    status,
    threadId,
    toolCallId: `call-${threadId}`,
  };
}

/** A host whose listing answers from `listed` and whose notices the test sends. */
function host(listed: Map<string, readonly AssistantThreadHostChild[]>) {
  let notify: ((threadId: string) => void) | undefined;
  const childThreads = vi.fn(async (threadId: string) => {
    const children = listed.get(threadId);
    if (!children) {
      throw new Error('Unknown thread');
    }
    return children;
  });
  return {
    capability: {
      childThreads,
      subscribeChildren: (listener: (threadId: string) => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    },
    childThreads,
    notify: (threadId: string) => notify?.(threadId),
  };
}

/** A tab selection the test moves, telling the store as the workspace store would. */
function selection(initial?: string) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    current: () => current,
    select: (threadId: string) => {
      current = threadId;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const stores: HostChildSidebarStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

it('lists an expanded parent’s children and re-reads them only when the host tells it', async () => {
  const listed = new Map([['root-1', [child('a', 'working')]]]);
  const fake = host(listed);
  const store = new HostChildSidebarStore(fake.capability, selection());
  stores.push(store);
  store.expand('root-1');
  await vi.waitFor(() => expect(store.getSnapshot().children.get('root-1')).toHaveLength(1));
  expect(fake.childThreads).toHaveBeenCalledTimes(1);

  listed.set('root-1', [child('a', 'needs-input')]);
  fake.notify('other-thread');
  expect(fake.childThreads).toHaveBeenCalledTimes(1);
  fake.notify('root-1');
  await vi.waitFor(() =>
    expect(store.getSnapshot().children.get('root-1')).toEqual([child('a', 'needs-input')])
  );
});

it('marks a child unread when its status changes away from its open tab, and clears it when seen', async () => {
  const listed = new Map([['root-1', [child('a', 'working'), child('b', 'working')]]]);
  const fake = host(listed);
  const tabs = selection('b');
  const store = new HostChildSidebarStore(fake.capability, tabs);
  stores.push(store);
  store.expand('root-1');
  await vi.waitFor(() => expect(store.getSnapshot().children.get('root-1')).toHaveLength(2));
  expect(store.getSnapshot().unread.size).toBe(0);

  listed.set('root-1', [child('a', 'idle'), child('b', 'needs-input')]);
  fake.notify('root-1');
  // The selected child's change is seen; the other child's is unread.
  await vi.waitFor(() => expect([...store.getSnapshot().unread]).toEqual(['a']));
  tabs.select('a');
  expect(store.getSnapshot().unread.size).toBe(0);
});

it('a collapsed parent stops being listed, and a refused listing shows why', async () => {
  const fake = host(new Map());
  const store = new HostChildSidebarStore(fake.capability, selection());
  stores.push(store);
  store.expand('missing');
  await vi.waitFor(() =>
    expect(store.getSnapshot().children.get('missing')).toEqual(new Error('Unknown thread'))
  );
  store.collapse('missing');
  expect(store.getSnapshot().children.has('missing')).toBe(false);
});
