import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type {
  AssistantThreadHostCapability,
  AssistantThreadHostChild,
} from './assistant-thread-host-context';

/** A child's delegation trail, outermost child first, ending with the child itself. */
export interface HostChildAncestry {
  readonly rootThreadId: string;
  readonly trail: readonly AssistantThreadHostChild[];
}

/** Each ancestor child resolves from its own committed origin, up to the top-level thread. */
export async function loadHostChildAncestry(
  host: AssistantThreadHostCapability,
  child: AssistantThreadHostChild
): Promise<HostChildAncestry> {
  if (!host.resolveChildThread) {
    throw new Error('This child conversation is not owned by the agent host.');
  }
  const trail = [child];
  let parentThreadId = child.parentThreadId;
  for (let level = child.depth - 1; level > 0; level -= 1) {
    const parent = await host.resolveChildThread(parentThreadId);
    trail.unshift(parent);
    parentThreadId = parent.parentThreadId;
  }
  return { rootThreadId: parentThreadId, trail };
}

export function findThread(
  threads: Readonly<Record<string, readonly AssistantMemoryThread[]>>,
  threadId: string | undefined
): AssistantMemoryThread | undefined {
  return threadId === undefined
    ? undefined
    : Object.values(threads)
        .flat()
        .find((thread) => thread.id === threadId);
}
