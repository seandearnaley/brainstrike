import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding,
} from '@brainstrike/app-shell';
import type { DbHandle } from '@brainstrike/db/react';

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
  readonly database: Pick<DbHandle, 'query'> | null;
  readonly mainRoot: AssistantOperatingRootCandidate | undefined;
  readonly threadId: string;
}): Promise<void> {
  const { client, threadId } = options;
  const { binding } = await client.request('thread/workspace/binding/read', { threadId });
  if (binding?.operatingRootId !== undefined || !options.mainRoot) {
    return;
  }
  if (!options.database) {
    throw new Error(
      'Cannot bind a host thread to its folder before the workspace database is ready.'
    );
  }
  const root = await resolveAssistantOperatingRootBinding(options.database, options.mainRoot);
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
