import type { HostClient } from '@brainstrike/agent-host/browser';
import type { StoredRootDescriptor } from '@brainstrike/types';

/**
 * Legacy parity (workspace-context "Thread and run binding"): a thread's
 * first request binds it to the explicit Main root, resolved to exactly one
 * live workspace identity; later Main or Focused changes never retarget it.
 * A host thread commits that binding through the host before the run it
 * starts, so Main's admission and the run's children see it. A thread that
 * is already bound (a folder thread, or one the user bound) keeps its binding;
 * with no Main root open, the run starts unbound, as legacy's did.
 */
export async function bindHostThreadToMainRoot(options: {
  readonly client: Pick<HostClient, 'request'>;
  readonly mainRoot: StoredRootDescriptor | undefined;
  readonly threadId: string;
}): Promise<void> {
  const { client, threadId } = options;
  const { binding } = await client.request('thread/workspace/binding/read', { threadId });
  if (binding?.operatingRootId !== undefined || !options.mainRoot) {
    return;
  }
  // Main supplies the canonical descriptor; the host validates its live mount
  // before committing the binding. No second path-to-ID lookup owns this fact.
  const root = options.mainRoot;
  await client.request('thread/workspace/binding/update', {
    commandId: crypto.randomUUID(),
    patch: {
      operatingRootDisplayName: root.displayName,
      operatingRootId: root.rootId,
      operatingRootPath: root.path,
    },
    threadId,
  });
}
