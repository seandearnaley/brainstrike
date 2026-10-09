import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { SharedFolderChip } from '@brainstrike/assistant-ui';
import { type ReactElement, useEffect, useState } from 'react';
import { useAssistantThreadHost } from './assistant-thread-host-context';
import { findThread, loadHostChildAncestry } from './host-child-ancestry';

type Root =
  | { readonly rootThreadId: string; readonly threadId: string }
  | { readonly error: Error; readonly threadId: string };

/**
 * BST-1932: a host child's composer names the workspace it shares with its
 * top-level thread, read-only, as its header does. Core lists only top-level
 * threads, so the folder is read from the root thread's row, never from a
 * child row the store does not hold; the root owns the folder, so the child
 * offers no way to add or change it.
 */
export function HostChildWorkspaceChip({ threadId }: { readonly threadId: string }): ReactElement {
  const host = useAssistantThreadHost();
  const [resolved, setResolved] = useState<Root>();
  useEffect(() => {
    let active = true;
    const resolve = async (): Promise<string> => {
      if (!host?.resolveChildThread) {
        throw new Error('This child conversation is not owned by the agent host.');
      }
      const child = await host.resolveChildThread(threadId);
      return (await loadHostChildAncestry(host, child)).rootThreadId;
    };
    resolve().then(
      (rootThreadId) => {
        if (active) {
          setResolved({ rootThreadId, threadId });
        }
      },
      (cause: unknown) => {
        if (active) {
          setResolved({
            error: cause instanceof Error ? cause : new Error(String(cause)),
            threadId,
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [host, threadId]);
  const current = resolved?.threadId === threadId ? resolved : undefined;
  const rootThreadId = current && 'rootThreadId' in current ? current.rootThreadId : undefined;
  const root = useAssistantThreadStore((state) =>
    findThread(state.threadsByResourceId, rootThreadId)
  );
  if (current && 'error' in current) {
    return (
      <p className="text-destructive text-xs" role="alert">
        {current.error.message}
      </p>
    );
  }
  if (!current) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Loading shared workspace…
      </p>
    );
  }
  return (
    <SharedFolderChip
      displayName={root?.metadata?.operatingRootDisplayName}
      path={root?.metadata?.operatingRootPath}
    />
  );
}
