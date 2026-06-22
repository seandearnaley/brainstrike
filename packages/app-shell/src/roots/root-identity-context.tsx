import { createLogger } from '@brainstrike/utils/logger';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

const logger = createLogger('RootIdentity');

// Module-level set so each unmapped DB root id only warns ONCE across the app's
// lifetime (not once per render / per quick-open query).
const warnedUnmappedDbRoots = new Set<string>();

/**
 * Maps the DB `roots.id` stored in `file_records.root_id` back to the file
 * explorer's adapter rootId (`handle.rootId`, what `activeRootIds`,
 * `rootDescriptors`, `encodeFileSelection`, and `openFileInTab` all use).
 *
 * The two identities COINCIDE for roots registered through reconcileRoots but
 * DIVERGE for legacy/path-matched roots (documented in
 * migrations/047-run-usage-root-id.ts). Any consumer that has a DB root_id and
 * needs the adapter id (e.g. ⌘P quick-open, to build the open compositeKey and
 * to gate by currently-mounted roots) MUST translate through this context — it
 * is the only authoritative correlation, derived from the reconciliation map.
 */
export interface RootIdentity {
  /**
   * Resolves the adapter rootId for a DB `roots.id`, or `null` when no
   * currently-mounted root maps to it (genuinely unmounted / unreconciled).
   * Logs once per unmapped DB id so a silent drop never goes unobserved.
   */
  resolveAdapterRootId: (dbRootId: string) => string | null;
}

const RootIdentityContext = createContext<RootIdentity | null>(null);

export interface RootIdentityProviderProps {
  readonly children: ReactNode;
  /**
   * The canonical adapter-rootId → DB-rootId map from `useRootsReconciliation`
   * (over currently-reconciled roots). Inverted here for DB → adapter lookups.
   */
  readonly dbRootIdByAdapterRootId: ReadonlyMap<string, string>;
}

export function RootIdentityProvider({
  dbRootIdByAdapterRootId,
  children,
}: RootIdentityProviderProps): ReactNode {
  const value = useMemo<RootIdentity>(() => {
    // Invert the forward map: DB roots.id → adapter rootId. DB ids are unique,
    // so the inverse is unambiguous.
    const adapterByDb = new Map<string, string>();
    for (const [adapterRootId, dbRootId] of dbRootIdByAdapterRootId) {
      adapterByDb.set(dbRootId, adapterRootId);
    }
    return {
      resolveAdapterRootId: (dbRootId: string): string | null => {
        const adapterRootId = adapterByDb.get(dbRootId);
        if (adapterRootId === undefined) {
          if (!warnedUnmappedDbRoots.has(dbRootId)) {
            warnedUnmappedDbRoots.add(dbRootId);
            logger.warn('DB root id has no mapped adapter root id', { dbRootId });
          }
          return null;
        }
        return adapterRootId;
      },
    };
  }, [dbRootIdByAdapterRootId]);

  return <RootIdentityContext.Provider value={value}>{children}</RootIdentityContext.Provider>;
}

/**
 * Reads the root-identity translator, or `null` when no provider is mounted
 * (e.g. the assistant panel, which renders as a SIBLING of the workspace-sync
 * subtree that owns the provider). Consumers MUST handle the null case honestly
 * rather than BLINDLY assuming DB id === adapter id.
 *
 * "Honestly" permits a VERIFIED-membership fallback: a DB root_id may be used as
 * the adapter id when it is itself a currently-mounted adapter root (present in
 * the live `activeRootIds`/`rootDescriptors` set). That never invents a mapping —
 * it is exact wherever `reconcileRoots` established identity (roots.id == adapter
 * rootId, the common case) and drops what it can't resolve. KNOWN LIMITATION: a
 * MOUNTED root whose adapter id was path-matched to a different pre-existing
 * roots.id (so roots.id != adapter rootId) cannot be resolved by the fallback —
 * only by this authoritative provider. Such a drop is logged once per id (see
 * `use-file-mentions.ts`); the durable fix is to mount this provider around the
 * consuming subtree too.
 */
export function useOptionalRootIdentity(): RootIdentity | null {
  return useContext(RootIdentityContext);
}
