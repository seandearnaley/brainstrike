import { createLogger } from '@brainstrike/logging';
import type {
  AssistantThreadHostCapability,
  AssistantThreadHostChild,
} from './assistant-thread-host-context';

const logger = createLogger('HostChildSidebar');
const DISCOVERY_FAILURE = 'Child conversations could not be loaded. Try again.';

export interface HostChildSidebarSnapshot {
  /** Each observed host parent's children, in delegation order, or why they could not be read. */
  readonly children: ReadonlyMap<string, readonly AssistantThreadHostChild[] | Error>;
  /** Children whose status changed while their tab was not the selected one. */
  readonly unread: ReadonlySet<string>;
}

/** The child thread whose workspace tab is selected, followed as the selection changes. */
export interface HostChildTabSelection {
  current(): string | undefined;
  subscribe(listener: () => void): () => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * BST-1932 (F19–F21): the threads panel's host child rows. A visible parent's
 * children are read from the host, and read again only when the host says that
 * parent's children changed: no polling, and no child log is watched. A child
 * whose status changes while its tab is not selected is unread until seen.
 */
export class HostChildSidebarStore {
  private readonly listeners = new Set<() => void>();
  private observed = new Set<string>();
  private readonly requests = new Map<string, number>();
  private snapshot: HostChildSidebarSnapshot = { children: new Map(), unread: new Set() };
  private sequence = 0;

  constructor(
    private readonly host: Required<
      Pick<AssistantThreadHostCapability, 'childThreads' | 'subscribeChildren'>
    >,
    private readonly selection: HostChildTabSelection
  ) {}

  /**
   * Follow the host's child notices and the tab selection until the returned
   * release. Construction subscribes to nothing: a view connects in its effect,
   * so a replayed or re-shown effect follows again rather than staying closed.
   * Parents read while nothing listened are read again: their children may have
   * changed unannounced.
   */
  connect(): () => void {
    const release = this.host.subscribeChildren((threadId) => {
      if (this.requests.has(threadId)) {
        this.read(threadId);
      }
    });
    // Selecting a child's tab sees its changes.
    const releaseSelection = this.selection.subscribe(() => {
      const selected = this.selection.current();
      if (selected) {
        this.markSeen(selected);
      }
    });
    for (const threadId of this.requests.keys()) {
      this.read(threadId);
    }
    return () => {
      release();
      releaseSelection();
    };
  }

  readonly getSnapshot = (): HostChildSidebarSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Discover disclosure for visible parents, including collapsed ones. */
  observe(threadIds: readonly string[]): void {
    const next = new Set(threadIds);
    const previous = this.observed;
    this.observed = next;
    for (const threadId of previous) {
      if (!next.has(threadId)) {
        this.collapse(threadId);
      }
    }
    for (const threadId of next) {
      this.expand(threadId);
    }
  }

  expand(threadId: string): void {
    if (!this.requests.has(threadId)) {
      this.read(threadId);
    }
  }

  retry(threadId: string): void {
    if (this.requests.has(threadId)) {
      this.read(threadId);
    }
  }

  collapse(threadId: string): void {
    if (this.observed.has(threadId)) {
      return;
    }
    this.requests.delete(threadId);
    const children = new Map(this.snapshot.children);
    children.delete(threadId);
    this.publish({ ...this.snapshot, children });
  }

  /** The child's tab was selected: its changes are seen. */
  markSeen(threadId: string): void {
    if (!this.snapshot.unread.has(threadId)) {
      return;
    }
    const unread = new Set(this.snapshot.unread);
    unread.delete(threadId);
    this.publish({ ...this.snapshot, unread });
  }

  private read(threadId: string): void {
    const request = ++this.sequence;
    this.requests.set(threadId, request);
    this.host.childThreads(threadId).then(
      (listed) => this.settle(threadId, request, listed),
      (error: unknown) => this.settle(threadId, request, asError(error))
    );
  }

  private settle(
    threadId: string,
    request: number,
    listed: readonly AssistantThreadHostChild[] | Error
  ): void {
    // A collapse, or a newer read of the same parent, supersedes this answer.
    if (this.requests.get(threadId) !== request) {
      return;
    }
    if (listed instanceof Error) {
      logger.error('Host child threads could not be listed', { threadId });
    }
    const settled = listed instanceof Error ? new Error(DISCOVERY_FAILURE) : listed;
    const previous = this.snapshot.children.get(threadId);
    const unread = new Set(this.snapshot.unread);
    if (previous !== undefined && !(previous instanceof Error) && !(settled instanceof Error)) {
      const before = new Map(previous.map((child) => [child.threadId, child.status]));
      const selected = this.selection.current();
      for (const child of settled) {
        const status = before.get(child.threadId);
        if (status !== undefined && status !== child.status && child.threadId !== selected) {
          unread.add(child.threadId);
        }
      }
    }
    this.publish({ children: new Map(this.snapshot.children).set(threadId, settled), unread });
  }

  private publish(next: HostChildSidebarSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
