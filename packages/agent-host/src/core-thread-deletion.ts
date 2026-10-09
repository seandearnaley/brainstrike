import {
  abortHostThreadRuns,
  assertHostAdmissionCleanup,
  joinHostThreadDeletion,
} from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';
import type { HostResults } from './protocol.js';

type Deleted = Promise<HostResults['thread/delete']>;

/** The Core state one thread deletion reads and retires; Core stays its only writer. */
export interface HostThreadDeletionPorts {
  /** Core's admission queue: the deletion runs after it, and later admissions after the deletion. */
  readonly admission: { get(): Promise<void>; set(next: Promise<void>): void };
  readonly closeRunOwner: (run: HostRunState) => Promise<void>;
  readonly closing: () => boolean;
  readonly conversationIds: Set<string>;
  readonly deletions: Map<string, Deleted>;
  readonly erase: ((threadId: string) => Promise<unknown>) | undefined;
  readonly failedAdmissions: ReadonlyMap<string, unknown>;
  readonly finish: (run: HostRunState) => Promise<void>;
  readonly forget: (threadId: string) => void;
  readonly pendingAdmissions: ReadonlyMap<AbortController, string>;
  readonly runs: Map<string, HostRunState>;
  /** BST-1932: a thread with its child threads, deleted through this same path. */
  readonly subtree: (threadId: string) => readonly string[];
  readonly threads: ReadonlySet<string>;
}

/** BST-1977: raw StateStore deletion cannot retire active Memory/provider work. */
export function deleteHostThread(threadId: string, ports: HostThreadDeletionPorts): Deleted {
  const existing = ports.deletions.get(threadId);
  if (existing) {
    return existing;
  }
  if (ports.closing()) {
    return Promise.reject(new Error('Host is closing'));
  }
  if (!ports.threads.has(threadId)) {
    return Promise.reject(new Error('Unknown thread'));
  }
  const erase = ports.erase;
  if (!erase) {
    return Promise.reject(new Error('The Root owner has no thread deletion capability'));
  }
  const subtree = ports.subtree(threadId);
  const deletion = ports.admission.get().then(async (): Deleted => {
    if (ports.closing()) {
      throw new Error('Host is closing');
    }
    for (const member of subtree) {
      assertHostAdmissionCleanup(ports.failedAdmissions, member);
    }
    const runs = [...ports.runs.values()].filter((run) => subtree.includes(run.threadId));
    await joinHostThreadDeletion(runs, ports.closeRunOwner, ports.finish);
    for (const member of subtree) {
      await erase(member);
      ports.forget(member);
    }
    for (const run of runs) {
      ports.runs.delete(run.id);
      ports.conversationIds.delete(run.id);
    }
    return { deleted: true, threadIds: [...subtree] };
  });
  for (const member of subtree) {
    ports.deletions.set(member, deletion);
    abortHostThreadRuns(member, ports.pendingAdmissions, ports.runs.values());
  }
  ports.admission.set(
    deletion.then(
      () => undefined,
      () => undefined
    )
  );
  return deletion;
}
