import type { HostEvent, HostLogRow, HostParams } from './protocol.js';

/** The thread catalog's committed titles, folded from Core's own log; owns no writer. */
export class HostThreadTitleState {
  private readonly titles = new Map<string, string>();

  constructor(
    private readonly commit: (
      params: HostParams<'thread/rename'>,
      event: Extract<HostEvent, { type: 'thread.renamed' }>
    ) => Promise<void>
  ) {}

  fold(row: HostLogRow): void {
    if (row.event.type === 'thread.renamed') {
      this.titles.set(row.threadId, row.event.title);
    }
  }

  forget(threadId: string): void {
    this.titles.delete(threadId);
  }

  /** A thread never renamed has no committed title; the client shows its default. */
  read(threadId: string): { title?: string } {
    const title = this.titles.get(threadId);
    return title === undefined ? {} : { title };
  }

  async rename(params: HostParams<'thread/rename'>): Promise<{ accepted: true }> {
    await this.commit(params, { title: params.title, type: 'thread.renamed' });
    return { accepted: true };
  }
}
