import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type { DeprecatedEnvVarReport, ProviderKeySource } from '@brainstrike/assistant-contract';
import {
  listProviders,
  PROVIDER_DEFAULT_ENABLED_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useModelToggle } from '../models/use-model-toggle';
import { CredentialInventory } from '../secrets/credential-inventory/credential-inventory';
import { listCredentialSlots } from '../secrets/credential-inventory/credential-slots';
import { CredentialLoadError } from '../secrets/credential-load-error';
import { EnvironmentSection } from '../secrets/environment/environment-section';
import { ProviderCard } from './provider-card';
import { buildProviderRuntimeGroups, listRecommendedProviders } from './provider-connection';
import { ProviderRecommendationPanel } from './provider-recommendation-panel';
import { useCredentialSources } from './use-credential-sources';
import { useProviderAuthStates } from './use-provider-auth-states';
import type { VerifyProvider } from './use-provider-verification-state';

/**
 * How long a cross-linked row stays ringed. Long enough to find the row after
 * the smooth scroll settles, short enough that the ring reads as "here it is"
 * rather than as a persistent selection the user must dismiss.
 */
const HIGHLIGHT_DURATION_MS = 2500;

const EMPTY_MODELS: readonly DbModel[] = Object.freeze([]);
const EMPTY_MODEL_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_FILTER: readonly string[] = Object.freeze([]);

interface HighlightTarget {
  /** Bumped per activation so re-picking the same slot re-triggers the scroll. */
  readonly nonce: number;
  readonly slotId: string;
}

export interface ProvidersSettingsProps {
  /**
   * Reveals an env file in the OS file manager. INJECTED by the host and
   * capability-gated on the desktop shell bridge — this package never reaches
   * for `window.platform`, and web simply never passes it.
   */
  readonly onRevealPath?:
    | ((absolutePath: string) => Promise<{ ok: boolean; error?: string }>)
    | undefined;
  /** Deprecated env names found set, from the assistant status probe (BST-1361). */
  readonly statusDeprecatedEnvVars?: readonly DeprecatedEnvVarReport[] | undefined;
  readonly statusError?: string | undefined;
  readonly statusProviderKeySources?: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  /**
   * Runs one verification probe. A plain async FUNCTION, not a hook: this
   * package cannot import app-shell (which depends on it), and passing a hook
   * as a value breaks the rules of hooks at the wiring site.
   */
  readonly verifyProvider: VerifyProvider;
}

/**
 * The Provider Hub (BST-1358): one surface for the whole "add a key → verify
 * it → enable models → chat" journey.
 *
 * Composition, not reimplementation — each card's credential section IS the
 * Credential Inventory table filtered to that provider, the model toggles read
 * and write the same DB-backed registry store the catalog uses, and the
 * environment report is BST-1363's section unchanged.
 *
 * @platform desktop (full) / web (read-only status)
 */
export function ProvidersSettings({
  onRevealPath,
  statusDeprecatedEnvVars,
  statusError,
  statusProviderKeySources,
  verifyProvider,
}: ProvidersSettingsProps) {
  const models = useModelRegistryStore((registry) => registry.models);
  useEnsureModelRegistry();
  // Shared with the Model Catalog list, so the two surfaces cannot drift in
  // how a toggle is attempted or how a failure is reported.
  const { busyModelIds, toggle: handleToggleModel } = useModelToggle();

  const { editable, error, sourcesBySlotId, state } =
    useCredentialSources(statusProviderKeySources);
  // Subscription providers authenticate by sign-in, so their state comes from
  // the OAuth bridge rather than the credential listing (BST-1356).
  const authStates = useProviderAuthStates();

  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<HighlightTarget | null>(null);

  // Every card on this page is a credential or a connection to configure. The
  // built-in on-device provider is keyless and embeddings-only, so it has
  // neither: its models are chosen in Settings → Embedding, which owns the
  // on-device embedding runtime. Registry-derived (`runtime`), never a
  // provider-id branch (provider-branch-guard.test.ts).
  const availableDefinitions = useMemo(
    () => listProviders().filter((definition) => definition.runtime !== 'on-device'),
    []
  );

  const groups = useMemo(
    () =>
      buildProviderRuntimeGroups({
        authStates,
        definitions: availableDefinitions,
        sourceState: state,
        sourcesBySlotId,
      }),
    [authStates, availableDefinitions, sourcesBySlotId, state]
  );

  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, DbModel[]>();
    for (const model of models) {
      const existing = grouped.get(model.providerId);
      if (existing) {
        existing.push(model);
      } else {
        grouped.set(model.providerId, [model]);
      }
    }
    return grouped;
  }, [models]);

  /**
   * Slots no provider card owns — today the Tavily web-search key, which is
   * deliberately outside the LLM provider registry. Derived by difference, so
   * a future non-provider slot is homed automatically rather than orphaned.
   */
  const unclaimedSlotIds = useMemo(() => {
    const providerIds = new Set<string>(listProviders().map((definition) => definition.id));
    const unclaimed: string[] = [];
    for (const slot of listCredentialSlots()) {
      if (!providerIds.has(slot.id)) {
        unclaimed.push(slot.id);
      }
    }
    return unclaimed;
  }, []);

  /**
   * Per-provider props that must keep a STABLE identity across renders: a
   * fresh `[id]` array or `Set` on every render defeats every memo downstream
   * and re-mounts the filtered inventory. Built once from the registry, which
   * cannot change at runtime.
   */
  const providerFilters = useMemo(() => {
    const filters = new Map<string, readonly string[]>();
    for (const definition of listProviders()) {
      filters.set(definition.id, Object.freeze([definition.id]));
    }
    return filters;
  }, []);

  const recommendedModelIds = useMemo(() => {
    const byProvider = new Map<string, ReadonlySet<string>>();
    for (const definition of listProviders()) {
      const defaults = PROVIDER_DEFAULT_ENABLED_MODELS[definition.id];
      byProvider.set(definition.id, defaults ? new Set(defaults) : EMPTY_MODEL_IDS);
    }
    return byProvider;
  }, []);

  const anyConnected = useMemo(
    () => groups.some((group) => group.providers.some((card) => card.connection === 'connected')),
    [groups]
  );
  const recommendations = useMemo(() => listRecommendedProviders(groups), [groups]);

  const highlightSlot = useCallback((slotId: string) => {
    setHighlight((previous) => ({ nonce: (previous?.nonce ?? 0) + 1, slotId }));
  }, []);

  // The ring is a pointer, not a selection: it expires on its own. A fresh
  // activation replaces the object, which restarts the timer.
  useEffect(() => {
    if (!highlight) {
      return;
    }
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  /**
   * Cross-link from the Environment section's variable chips (BST-1363).
   *
   * RE-HOMED for this surface: the chip and its target row are no longer
   * siblings — a provider's row now lives inside a COLLAPSED card — so the
   * nearest common parent is this page, and the handler must open the owning
   * card before the ring can mean anything. A slot with no provider card
   * (Tavily) already sits in the always-visible other-credentials table, so it
   * only needs the ring.
   */
  const handleSelectCredentialSlot = useCallback(
    (slotId: string) => {
      if (!unclaimedSlotIds.includes(slotId)) {
        setExpandedProviderId(slotId);
      }
      highlightSlot(slotId);
    },
    [highlightSlot, unclaimedSlotIds]
  );

  const handleConnectRecommendation = useCallback(
    (providerId: string) => {
      setExpandedProviderId(providerId);
      highlightSlot(providerId);
    },
    [highlightSlot]
  );

  const handleToggleExpanded = useCallback((providerId: string) => {
    setExpandedProviderId((current) => (current === providerId ? null : providerId));
  }, []);

  return (
    <div className="space-y-6" data-testid="providers-settings">
      <CredentialLoadError message={error} />

      {/* With no source of truth (web), "nothing is connected" is not a fact
          we hold — so the first-run panel stays away rather than inviting the
          user to fix a problem we cannot see. */}
      {anyConnected || state === 'unavailable' ? null : (
        <ProviderRecommendationPanel
          onConnect={handleConnectRecommendation}
          providers={recommendations}
        />
      )}

      {groups.map((group) => (
        <section className="space-y-2" key={group.runtime}>
          <h3
            className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
            data-testid={`provider-group-${group.runtime}`}
          >
            {group.label}
          </h3>
          <div className="space-y-2">
            {group.providers.map((card) => (
              <ProviderCard
                busyModelIds={busyModelIds}
                card={card}
                editable={editable}
                expanded={expandedProviderId === card.definition.id}
                highlightedSlotId={highlight?.slotId}
                highlightNonce={highlight?.nonce ?? 0}
                key={card.definition.id}
                models={modelsByProvider.get(card.definition.id) ?? EMPTY_MODELS}
                onRequestExpand={setExpandedProviderId}
                onToggleExpanded={handleToggleExpanded}
                onToggleModel={handleToggleModel}
                providerFilter={providerFilters.get(card.definition.id) ?? EMPTY_FILTER}
                recommendedModelIds={recommendedModelIds.get(card.definition.id) ?? EMPTY_MODEL_IDS}
                sourceState={state}
                statusDeprecatedEnvVars={statusDeprecatedEnvVars}
                statusError={statusError}
                statusProviderKeySources={statusProviderKeySources}
                verifyProvider={verifyProvider}
              />
            ))}
          </div>
        </section>
      ))}

      {editable && unclaimedSlotIds.length > 0 ? (
        <Card data-testid="other-credentials-section">
          <CardHeader>
            <CardTitle className="text-base">Other credentials</CardTitle>
            <p className="text-muted-foreground text-xs">
              Keys for services that are not model providers.
            </p>
          </CardHeader>
          <CardContent>
            <CredentialInventory
              deprecatedEnvVars={statusDeprecatedEnvVars}
              highlightedSlotId={highlight?.slotId}
              highlightNonce={highlight?.nonce ?? 0}
              providers={unclaimedSlotIds}
              statusError={statusError}
              statusProviderKeySources={statusProviderKeySources}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="provider-environment-section">
        <CardHeader>
          <CardTitle className="text-base">Environment</CardTitle>
          <p className="text-muted-foreground text-xs">
            Environment variables always win over keys stored here. Select a variable to jump to the
            credential it fills.
          </p>
        </CardHeader>
        <CardContent>
          <EnvironmentSection
            deprecatedEnvVars={statusDeprecatedEnvVars}
            onRevealPath={onRevealPath}
            onSelectCredentialSlot={handleSelectCredentialSlot}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default ProvidersSettings;
