import type { HostRetrieval } from '../../agent-host-platform/host-executed-tools';

const unexpected = async (): Promise<never> => {
  throw new Error('unexpected retrieval read');
};

/** The host's index and retrieval catalog for a scenario whose tools never read them. */
export function unusedHostRetrieval(): HostRetrieval {
  return {
    indexSearch: {
      coverage: unexpected,
      coverageBatch: unexpected,
      grep: unexpected,
      rebuild: unexpected,
      search: unexpected,
      status: unexpected,
    },
    store: {
      embeddingSet: unexpected,
      embeddingSpaces: unexpected,
      fileRecords: unexpected,
    },
  };
}
