import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type {
  ProviderDefinition,
  ProviderRuntime,
} from '@brainstrike/assistant-contract/provider-metadata';
import type { CredentialSourceState } from '../secrets/provider-key-types';

/**
 * Credential-listing readiness, widened with `unavailable`.
 *
 * `unavailable` means "this build has NO source of truth for credentials" —
 * a renderer with no `window.secrets` bridge and no status payload. It is
 * distinct from `ready`-with-nothing-found, and collapsing the two is what
 * once made every provider render as "Not connected" behind a
 * permanent first-run panel.
 */
export type ProviderSourceState = CredentialSourceState | 'unavailable';

/**
 * Whether the runtime can authenticate as this provider right now.
 *
 * `unknown` is deliberately distinct from `disconnected` — while the credential
 * listing is loading, has FAILED, or is unavailable entirely, "not set" is a
 * claim the data cannot support (NO SILENT FALLBACKS).
 */
export type ProviderConnectionState = 'connected' | 'disconnected' | 'unknown';

export interface ProviderCardModel {
  readonly connection: ProviderConnectionState;
  readonly definition: ProviderDefinition;
  /**
   * Position in the registry array — the ONLY priority order the registry
   * defines (it carries no `sort_order` field). Runtime grouping reshuffles
   * the cards for display, so recommendations keep this to rank across groups.
   */
  readonly registryIndex: number;
  /** The winning credential source, when the listing reported one. */
  readonly source: ProviderKeySource<string> | undefined;
}

export interface ProviderRuntimeGroup {
  readonly label: string;
  readonly providers: readonly ProviderCardModel[];
  readonly runtime: ProviderRuntime;
}

/**
 * Same order and labels the model picker groups by
 * (`use-assistant-model-picker-config.ts`), so a provider sits in the same
 * place in Settings as it does in the composer.
 */
export const PROVIDER_RUNTIME_ORDER: readonly ProviderRuntime[] = ['hosted', 'gateway'];

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  gateway: 'Gateway',
  hosted: 'Hosted',
};

/** How many providers the first-run panel suggests. */
const RECOMMENDATION_COUNT = 3;

export function resolveProviderConnection({
  source,
  sourceState,
}: {
  readonly source: ProviderKeySource<string> | undefined;
  readonly sourceState: ProviderSourceState;
}): ProviderConnectionState {
  if (source) {
    return 'connected';
  }
  return sourceState === 'ready' ? 'disconnected' : 'unknown';
}

/** Connected sorts before everything else; ties keep registry order. */
function connectionRank(connection: ProviderConnectionState): number {
  return connection === 'connected' ? 0 : 1;
}

export function buildProviderRuntimeGroups({
  definitions,
  sourcesBySlotId,
  sourceState,
}: {
  readonly definitions: readonly ProviderDefinition[];
  readonly sourcesBySlotId: ReadonlyMap<string, ProviderKeySource<string>>;
  readonly sourceState: ProviderSourceState;
}): readonly ProviderRuntimeGroup[] {
  const byRuntime = new Map<ProviderRuntime, ProviderCardModel[]>(
    PROVIDER_RUNTIME_ORDER.map((runtime) => [runtime, []])
  );

  definitions.forEach((definition, registryIndex) => {
    const source = sourcesBySlotId.get(definition.id);
    const bucket = byRuntime.get(definition.runtime);
    if (!bucket) {
      // A runtime outside the known order would silently vanish from the page.
      throw new Error(
        `Provider "${definition.id}" declares unknown runtime "${definition.runtime}".`
      );
    }
    bucket.push({
      connection: resolveProviderConnection({ source, sourceState }),
      definition,
      registryIndex,
      source,
    });
  });

  const groups: ProviderRuntimeGroup[] = [];
  for (const runtime of PROVIDER_RUNTIME_ORDER) {
    const providers = byRuntime.get(runtime) ?? [];
    if (providers.length === 0) {
      continue;
    }
    groups.push({
      label: RUNTIME_LABELS[runtime],
      // Array.prototype.sort is stable in every engine we target, so equal
      // ranks preserve the registry order the definitions arrived in.
      providers: [...providers].sort(
        (left, right) => connectionRank(left.connection) - connectionRank(right.connection)
      ),
      runtime,
    });
  }
  return groups;
}

/**
 * First-run suggestions: the highest-priority providers the user could
 * actually connect. Priority IS registry order — the registry carries no
 * separate sort field, and inventing one here would be a second source of
 * truth.
 */
export function listRecommendedProviders(
  groups: readonly ProviderRuntimeGroup[]
): readonly ProviderCardModel[] {
  const connectable: ProviderCardModel[] = [];
  for (const group of groups) {
    for (const card of group.providers) {
      if (card.connection === 'disconnected') {
        connectable.push(card);
      }
    }
  }
  // Groups are runtime-ordered, so ranking by registry index restores the
  // single priority order the registry defines — otherwise a gateway provider
  // could never be recommended ahead of a low-priority hosted one.
  return connectable
    .sort((left, right) => left.registryIndex - right.registryIndex)
    .slice(0, RECOMMENDATION_COUNT);
}
