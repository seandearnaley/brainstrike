import type { DbModel } from '@brainstrike/app-state/stores/model-registry-store';
import type {
  DeprecatedEnvVarReport,
  ProviderKeySource,
  ProviderVerificationLookup,
  ProviderVerificationSnapshot,
} from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { Badge, Button, Card, cn, getProviderColor, ProviderIcon } from '@brainstrike/ui';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CredentialInventory } from '../secrets/credential-inventory/credential-inventory';
import { KeySourceBadge } from '../secrets/key-source-badge';
import type {
  ProviderCardModel,
  ProviderConnectionState,
  ProviderSourceState,
} from './provider-connection';
import { ProviderModelSection } from './provider-model-section';
import { ProviderTestConnection } from './provider-test-connection';
import { PROVIDER_VERIFICATION_PRESENTATION } from './provider-verification-presentation';
import {
  useProviderVerificationState,
  type VerifyProvider,
} from './use-provider-verification-state';

/** Stable identity so gating the verdict cannot churn downstream memos. */
const IDLE_LOOKUP: ProviderVerificationLookup = { state: 'idle' };

const CONNECTION_LABELS: Record<ProviderConnectionState, string> = {
  connected: 'Connected',
  disconnected: 'Not connected',
  unknown: 'Status unknown',
};

const CONNECTION_DOT_CLASSES: Record<ProviderConnectionState, string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-muted-foreground/40',
  unknown: 'bg-amber-500/70',
};

/** Verb on the expand control, so the card states what it is FOR. */
const PRIMARY_ACTION_LABELS: Record<ProviderConnectionState, string> = {
  connected: 'Manage',
  disconnected: 'Connect',
  unknown: 'Manage',
};

export interface ProviderCardProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly card: ProviderCardModel;
  /** Desktop can write credentials; web renders the same state read-only. */
  readonly editable: boolean;
  readonly expanded: boolean;
  readonly highlightedSlotId: string | undefined;
  readonly highlightNonce: number;
  readonly models: readonly DbModel[];
  /** Opens this card when a verified credential arrives while it is collapsed. */
  readonly onRequestExpand: (providerId: string) => void;
  readonly onToggleExpanded: (providerId: string) => void;
  readonly onToggleModel: (modelId: string, enabled: boolean) => void;
  /** Memoised per provider id by the page — never build this inline. */
  readonly providerFilter: readonly string[];
  readonly recommendedModelIds: ReadonlySet<string>;
  readonly sourceState: ProviderSourceState;
  readonly statusDeprecatedEnvVars: readonly DeprecatedEnvVarReport[] | undefined;
  readonly statusError: string | undefined;
  readonly statusProviderKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
  /** Plain async probe injected by the host; see {@link VerifyProvider}. */
  readonly verifyProvider: VerifyProvider;
}

/**
 * Whether the runtime can authenticate. A stored key the provider REJECTED is
 * still stored, but it does not connect: the card face must not pair a green
 * "Connected" with an "Invalid key" verdict (BST-1981).
 */
function ConnectionBadge({
  connection,
  providerId,
  rejected,
}: {
  readonly connection: ProviderConnectionState;
  readonly providerId: string;
  readonly rejected: boolean;
}) {
  return (
    <span
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
      data-connection={connection}
      data-testid={`provider-connection-${providerId}`}
      data-verdict={rejected ? 'invalid' : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          rejected ? 'bg-destructive' : CONNECTION_DOT_CLASSES[connection]
        )}
      />
      {rejected ? 'Key rejected' : CONNECTION_LABELS[connection]}
    </span>
  );
}

/** Names the credential store for the card header. */
function ProviderKeySourceBadge({
  card,
  sourceState,
}: {
  readonly card: ProviderCardModel;
  readonly sourceState: ProviderSourceState;
}) {
  const testId = `provider-key-source-${card.definition.id}`;
  if (sourceState === 'unavailable') {
    // No bridge and no status payload: naming a store would be a guess.
    return (
      <Badge className="text-muted-foreground" data-testid={testId} variant="outline">
        Source unavailable
      </Badge>
    );
  }
  return <KeySourceBadge source={card.source} sourceState={sourceState} testId={testId} />;
}

/**
 * The probe verdict, compact enough for the card header.
 *
 * The auto-probe fires on a credential arriving, which can happen while the
 * card is COLLAPSED — so the result has to be legible without expanding, or an
 * automatic check could fail invisibly.
 */
function VerdictChip({
  lookup,
  providerId,
}: {
  readonly lookup: ProviderVerificationLookup;
  readonly providerId: string;
}) {
  if (lookup.state !== 'resolved') {
    return null;
  }
  const { status } = lookup.snapshot.result;
  const presentation = PROVIDER_VERIFICATION_PRESENTATION[status];
  return (
    <Badge
      className={cn(
        'h-5 px-1.5 text-[10px]',
        presentation.tone === 'danger' && 'border-destructive/40 text-destructive',
        presentation.tone === 'warning' && 'text-warning border-amber-500/40',
        presentation.tone === 'success' && 'text-success border-emerald-500/40'
      )}
      data-status={status}
      data-testid={`provider-verdict-chip-${providerId}`}
      variant="outline"
    >
      {presentation.label}
    </Badge>
  );
}

export function ProviderCard({
  busyModelIds,
  card,
  editable,
  expanded,
  highlightNonce,
  highlightedSlotId,
  models,
  onRequestExpand,
  onToggleExpanded,
  onToggleModel,
  providerFilter,
  recommendedModelIds,
  sourceState,
  statusDeprecatedEnvVars,
  statusError,
  statusProviderKeySources,
  verifyProvider,
}: ProviderCardProps) {
  const { definition } = card;
  const providerId = definition.id;
  const chainProbeFired = useRef(false);

  // The chain's reaction to a verdict is an EVENT, not an effect: the moment a
  // probe resolves we know whether it authenticated, so the card asks the page
  // to open it right there. Watching the verdict in an effect and calling a
  // parent callback from it was pushing state upward from a render pass — the
  // thing `no-prop-callback-in-effect` exists to stop — and it needed a second
  // latch to stay idempotent.
  const handleProbeResolved = (snapshot: ProviderVerificationSnapshot) => {
    if (!chainProbeFired.current) {
      return;
    }
    chainProbeFired.current = false;
    const { status } = snapshot.result;
    // Only a credential that actually authenticated earns the model step.
    if (status === 'verified' || status === 'verified_limited') {
      onRequestExpand(providerId);
    }
  };

  // The probe is button-driven, so naming the provider unconditionally costs
  // nothing and keeps chaining available on a collapsed card.
  const { lookup, verify } = useProviderVerificationState({
    onResolved: handleProbeResolved,
    providerId,
    verifyProvider,
  });

  // ── Connect → models chaining ──────────────────────────────────────────
  // The signal is the OBSERVED arrival of a credential, not a click: the
  // editor lives inside CredentialInventory and reports success by bumping
  // `secretsVersion`, which re-reads the listing and flips this card's
  // connection state. Chaining on that means it fires for every route into a
  // credential and never lies about a save that failed.
  //
  // The gate is "we previously saw this provider SETTLED as disconnected".
  // Two things make that the right test rather than a previous-state
  // comparison: the re-read passes through `unknown` while it loads, so the
  // immediately-previous state is not `disconnected`; and on page load an
  // already-connected provider goes `unknown → connected`, which must NOT
  // probe — BST-1357 is explicit that verification never fires on mere render.
  //
  // Tracked by adjusting state DURING RENDER rather than in an effect: this is
  // derived state, and an effect would cost a cascading render per transition.
  const [chainTracker, setChainTracker] = useState(() => ({
    awaitingChain: false,
    connection: card.connection,
    sawDisconnected: card.connection === 'disconnected',
  }));

  if (chainTracker.connection !== card.connection) {
    setChainTracker({
      awaitingChain: card.connection === 'connected' && chainTracker.sawDisconnected,
      connection: card.connection,
      // STICKY through `unknown`: re-reading the listing after a save flips
      // this card disconnected → unknown → connected, and a memory that
      // cleared on the loading blip would lose the very transition it exists
      // to detect. Cleared once reaching `connected` consumes it.
      sawDisconnected:
        card.connection !== 'connected' &&
        (card.connection === 'disconnected' || chainTracker.sawDisconnected),
    });
  }

  // Firing the probe IS a side effect, so it stays in an effect — but it sets
  // no state of its own, and the latch keeps it to exactly one probe per
  // transition regardless of `verify`'s identity.
  useEffect(() => {
    if (!chainTracker.awaitingChain) {
      return;
    }
    if (chainProbeFired.current) {
      return;
    }
    chainProbeFired.current = true;
    verify();
  }, [chainTracker.awaitingChain, verify]);

  const enabledCount = models.filter((model) => model.isEnabled).length;
  // A verdict describes the CURRENT credential only (see the probe below).
  const verdict = card.connection === 'connected' ? lookup : IDLE_LOOKUP;
  const rejected = verdict.state === 'resolved' && verdict.snapshot.result.status === 'invalid';

  return (
    <Card
      className={cn(
        'overflow-hidden transition-colors',
        card.connection === 'connected' && !rejected && 'border-emerald-500/30'
      )}
      data-testid={`provider-card-${providerId}`}
    >
      <button
        aria-controls={`provider-card-body-${providerId}`}
        aria-expanded={expanded}
        className="hover:bg-muted/40 focus-visible:outline-ring flex w-full items-center gap-3 p-4 text-left focus-visible:outline-2"
        data-testid={`provider-card-toggle-${providerId}`}
        onClick={() => onToggleExpanded(providerId)}
        type="button"
      >
        <span
          className="bg-muted/30 flex size-9 shrink-0 items-center justify-center rounded-lg border [--provider-color:var(--provider-color-light)] dark:[--provider-color:var(--provider-color-dark)]"
          style={
            {
              '--provider-color-dark': getProviderColor(providerId, 'dark'),
              '--provider-color-light': getProviderColor(providerId, 'light'),
            } as CSSProperties
          }
        >
          <ProviderIcon
            className="size-4"
            providerId={providerId}
            style={{ color: 'var(--provider-color)' }}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{definition.displayName}</span>
            <ProviderKeySourceBadge card={card} sourceState={sourceState} />
            <VerdictChip lookup={verdict} providerId={providerId} />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-3">
            <ConnectionBadge
              connection={card.connection}
              providerId={providerId}
              rejected={rejected}
            />
            {models.length > 0 ? (
              <span
                className="text-muted-foreground text-xs"
                data-testid={`provider-card-models-${providerId}`}
              >
                {models.length} {models.length === 1 ? 'model' : 'models'} · {enabledCount} enabled
              </span>
            ) : null}
          </span>
        </span>

        <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
          {PRIMARY_ACTION_LABELS[card.connection]}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-4 transition-transform', expanded && 'rotate-180')}
          />
        </span>
      </button>

      {expanded ? (
        <div
          className="space-y-4 border-t px-4 py-4"
          data-testid={`provider-card-body-${providerId}`}
          id={`provider-card-body-${providerId}`}
        >
          <ProviderCredentialSection
            deprecatedEnvVars={statusDeprecatedEnvVars}
            editable={editable}
            highlightedSlotId={highlightedSlotId}
            highlightNonce={highlightNonce}
            providerFilter={providerFilter}
            providerId={providerId}
            statusError={statusError}
            statusProviderKeySources={statusProviderKeySources}
          />

          <ProviderGuidance docsUrl={definition.docsUrl} providerId={providerId} />

          <ProviderTestConnection
            disabled={card.connection !== 'connected'}
            // A verdict describes a credential. Once that credential is
            // gone the verdict is stale, so it is dropped rather than left
            // on screen vouching for a key that no longer exists.
            lookup={verdict}
            onVerify={verify}
            providerId={providerId}
          />

          <ProviderModelSection
            busyModelIds={busyModelIds}
            models={models}
            onToggle={onToggleModel}
            providerId={providerId}
            recommendedModelIds={recommendedModelIds}
          />
        </div>
      ) : null}
    </Card>
  );
}

interface ProviderCredentialSectionProps {
  readonly deprecatedEnvVars: readonly DeprecatedEnvVarReport[] | undefined;
  readonly editable: boolean;
  readonly highlightedSlotId: string | undefined;
  readonly highlightNonce: number;
  readonly providerFilter: readonly string[];
  readonly providerId: string;
  readonly statusError: string | undefined;
  readonly statusProviderKeySources: readonly ProviderKeySource<SupportedProvider>[] | undefined;
}

/**
 * The credential surface is the Credential Inventory table filtered to this
 * one provider (BST-1362's `providers` seam). Composing it rather than
 * reimplementing means every editor it grows appears here unchanged — the AWS
 * region/profile modes included.
 */
function ProviderCredentialSection({
  deprecatedEnvVars,
  editable,
  highlightNonce,
  highlightedSlotId,
  providerFilter,
  providerId,
  statusError,
  statusProviderKeySources,
}: ProviderCredentialSectionProps) {
  if (!editable) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid={`provider-readonly-note-${providerId}`}
      >
        Configured via the server environment — status unavailable here. Use the desktop app to
        store a key locally.
      </p>
    );
  }
  return (
    <CredentialInventory
      deprecatedEnvVars={deprecatedEnvVars}
      highlightedSlotId={highlightedSlotId}
      highlightNonce={highlightNonce}
      providers={providerFilter}
      statusError={statusError}
      statusProviderKeySources={statusProviderKeySources}
    />
  );
}

interface ProviderGuidanceProps {
  readonly docsUrl: string | undefined;
  readonly providerId: string;
}

/**
 * Registry metadata rendered verbatim — never provider-specific UI copy.
 *
 * Deliberately NARROWER than the registry's full guidance set: `keyNotes` and
 * `keyFormatHint` are rendered by the composed credential editor
 * (`credential-row-editor`, BST-1362) at the moment the user is actually
 * typing a key. That is both the better placement and the reason repeating
 * them here showed a provider's notes twice on one screen — caught in live CDT
 * verification on the Bedrock card. What survives is the one affordance the
 * editor cannot offer before it is opened: where to GET a key.
 */
function ProviderGuidance({ docsUrl, providerId }: ProviderGuidanceProps) {
  if (!docsUrl) {
    return null;
  }
  return (
    <div className="text-xs" data-testid={`provider-guidance-${providerId}`}>
      <Button asChild className="h-auto p-0 text-xs" variant="link">
        <a
          data-testid={`provider-docs-link-${providerId}`}
          href={docsUrl}
          rel="noreferrer"
          target="_blank"
        >
          Get an API key
          <ExternalLink aria-hidden="true" className="ml-1 size-3" />
        </a>
      </Button>
    </div>
  );
}
