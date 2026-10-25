import { getThreadGroupsCapability } from './thread-groups-capability';

export interface AssistantOperatingRootCandidate {
  readonly displayName: string;
  readonly path: string;
}

export interface PersistedAssistantOperatingRootBinding {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

/**
 * The AUTHORITATIVE "this path has no unique live `roots` row right now"
 * result — as opposed to the catalog read itself rejecting (a transient I/O
 * failure, connection issue, etc.), which tells you nothing about whether the
 * row exists. Callers that decide "wait for a registration event" vs. "this
 * needs a retry / must fail loud now" (`use-workspace-bar.ts`'s
 * `tryResolveRootId`) need this distinction as a TYPE, not a string-message
 * sniff: only THIS error means "no row (yet)"; anything else propagating from
 * the catalog read is a read failure that a future registration event will
 * never resolve.
 */
class AssistantOperatingRootRowNotFoundError extends Error {
  constructor(displayName: string) {
    super(
      `Cannot bind assistant thread to "${displayName}": the mounted folder has no unique live workspace identity.`
    );
    this.name = 'AssistantOperatingRootRowNotFoundError';
  }
}

export async function resolveAssistantOperatingRootBinding(
  candidate: AssistantOperatingRootCandidate
): Promise<PersistedAssistantOperatingRootBinding> {
  const catalog = getThreadGroupsCapability();
  if (!catalog) {
    throw new Error('Workspace root catalog unavailable');
  }
  const rows = (await catalog.readRoots()).filter(
    (row) => row.path === candidate.path && row.status === 'live'
  );
  if (rows.length !== 1 || !rows[0]?.id) {
    throw new AssistantOperatingRootRowNotFoundError(candidate.displayName);
  }
  return {
    displayName: candidate.displayName,
    path: candidate.path,
    rootId: rows[0].id,
  };
}
