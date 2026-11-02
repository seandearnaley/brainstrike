import type { HostCore } from './core.ts';
import type { HostThreadReads } from './ports.ts';

/** Core's thread reads for the workspace services, answered once Core has folded its log. */
export function foldedThreadReads(
  core: Pick<HostCore, 'hydrated' | 'listThreads' | 'published' | 'readLedger'>
): HostThreadReads {
  return {
    listThreads: () => core.hydrated.then(() => core.listThreads()),
    read: (threadId, fromSeq) => core.hydrated.then(() => core.published.read(threadId, fromSeq)),
    readLedger: () => core.hydrated.then(() => core.readLedger()),
  };
}
