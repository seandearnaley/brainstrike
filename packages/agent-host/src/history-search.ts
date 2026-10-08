import type { HostPlatform } from './ports.js';
import type { HostParams, HostResults } from './protocol.js';

/** History search over the host's derived state index; only current threads can match. */
export class HostHistory {
  constructor(
    private readonly read: () => {
      readonly platform: HostPlatform;
      readonly threads: ReadonlySet<string>;
    }
  ) {}

  async search(params: HostParams<'history/search'>): Promise<HostResults['history/search']> {
    const { platform, threads } = this.read();
    if (!platform.searchHistory) {
      throw new Error('This host has no history search capability');
    }
    // A deleted thread leaves the thread set before its derived rows are dropped.
    const hits = await platform.searchHistory({
      limit: params.limit,
      query: params.query,
      threads: [...threads],
    });
    return { hits: [...hits] };
  }
}
