import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { ProviderAuthState } from '@brainstrike/assistant-contract/provider-auth';
import type {
  ProviderAuthType,
  ProviderDefinition,
  ProviderRuntime,
} from '@brainstrike/assistant-contract/provider-metadata';
import type { CredentialSourceState } from '../secrets/provider-key-types';

/**
 * Credential-listing readiness, widened with `unavailable`.
 *
 * `unavailable` means "this build has NO source of truth for credentials" —
 * the web app, which has no `window.secrets` bridge and is passed no status
 * payload. It is distinct from `ready`-with-nothing-found, and collapsing the
 * two is what made every provider on web render as "Not connected" behind a
 * permanent first-run panel.
 */
export type ProviderSourceState = CredentialSourceState | 'unavailable';

/**
 * Whether the runtime can authenticate as this provider right now.
 *
 * `not-applicable` is deliberately distinct from `disconnected`: a keyless
 * local runtime has nothing to connect, and reporting it as disconnected would
 * invent a problem the user cannot fix on this surface. `unknown` is equally
 * deliberate — while the credential listing is loading, has FAILED, or is
 * unavailable entirely, "not set" is a claim the data cannot support (NO
 * SILENT FALLBACKS). `reconnect-required` is the subscription case: an account
 * exists, its session expired, and "Not connected" would send the user to
 * re-add something they never removed.
 */
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-applicable'
  | 'reconnect-required'
  | 'unknown';

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
export const PROVIDER_RUNTIME_ORDER: readonly ProviderRuntime[] = [
  'hosted',
  'gateway',
  'local',
  'browser',
];

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  browser: 'Browser',
  gateway: 'Gateway',
  hosted: 'Hosted',
  local: 'Local',
};

/** How many providers the first-run panel suggests. */
const RECOMMENDATION_COUNT = 3;

/**
 * Sign-in states that are a VERDICT. Everything else the OAuth engine can
 * report (`connecting`, `awaiting_browser`, `awaiting_device_code`, `error`)
 * is mid-flow or a failure, and resolves to `unknown` rather than being
 * flattened into "not connected".
 */
const OAUTH_VERDICTS: Partial<Record<ProviderAuthState, ProviderConnectionState>> = {
  connected: 'connected',
  disconnected: 'disconnected',
  // biome-ignore lint/style/useNamingConvention: BST-1355 wire state name, matched verbatim to the ProviderAuthStatus union.
  reconnect_required: 'reconnect-required',
};

export function resolveProviderConnection({
  authState,
  authType,
  source,
  sourceState,
}: {
  /** Sign-in state for `oauth_subscription` providers; absent means no bridge. */
  readonly authState?: ProviderAuthState | undefined;
  readonly authType: ProviderAuthType;
  readonly source: ProviderKeySource<string> | undefined;
  readonly sourceState: ProviderSourceState;
}): ProviderConnectionState {
  if (authType === 'none') {
    return 'not-applicable';
  }
  // BST-1356: a subscription provider's tokens live in the desktop OAuth
  // engine, NOT in the `secrets.list()` payload — reading the key listing for
  // one would report a signed-in account as "Not connected" forever.
  if (authType === 'oauth_subscription') {
    return authState ? (OAUTH_VERDICTS[authState] ?? 'unknown') : 'unknown';
  }
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
  authStates,
  definitions,
  sourcesBySlotId,
  sourceState,
}: {
  /** Sign-in state per `oauth_subscription` provider id. */
  readonly authStates?: ReadonlyMap<string, ProviderAuthState> | undefined;
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
      connection: resolveProviderConnection({
        authState: authStates?.get(definition.id),
        authType: definition.authType,
        source,
        sourceState,
      }),
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
      // The panel's offer is literally "add a key", so a subscription provider
      // does not belong in it — it is connected by signing in, and BST-1356 is
      // explicit that oauth must never be presented as paste-a-key.
      if (card.connection === 'disconnected' && card.definition.authType !== 'oauth_subscription') {
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
