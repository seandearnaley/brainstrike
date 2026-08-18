import type { DeprecatedEnvVarReport, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';
import { CredentialInventory } from './credential-inventory/credential-inventory';
import { EnvironmentSection } from './environment/environment-section';

/**
 * How long a cross-linked row stays ringed. Long enough to find the row after
 * the smooth scroll settles, short enough that the ring reads as "here it is"
 * rather than as a persistent selection the user must dismiss.
 */
const HIGHLIGHT_DURATION_MS = 2500;

interface HighlightTarget {
  /** Bumped per activation so re-picking the same slot re-triggers the scroll. */
  readonly nonce: number;
  readonly slotId: string;
}

export interface ApiKeysSettingsProps {
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
}

/**
 * Settings section for managing LLM provider API keys and the Tavily
 * web-search key: the all-keys Credential Inventory table (BST-1362), with the
 * read-only Environment bootstrap surface beneath it (BST-1363).
 * Uses the Electron `window.secrets` API for secure storage.
 *
 * The Environment section sits BELOW the inventory deliberately: the table is
 * the thing users came for, and the env report is the explanation they reach
 * for when a row does not say what they expect.
 *
 * Both surfaces receive the SAME `statusDeprecatedEnvVars` reports, so the
 * rename guidance they render can never disagree.
 *
 * @platform desktop
 */
export function ApiKeysSettings({
  onRevealPath,
  statusDeprecatedEnvVars,
  statusError,
  statusProviderKeySources,
}: ApiKeysSettingsProps = {}) {
  // Cross-link target owned HERE, the nearest common parent of the chip that
  // sets it and the row that renders it.
  const [highlight, setHighlight] = useState<HighlightTarget | null>(null);

  const selectCredentialSlot = useCallback((slotId: string) => {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Credential Inventory</CardTitle>
        <p className="text-muted-foreground text-xs">
          One row per credential. Environment variables always win over keys stored here; the
          Variable column is the exact name to use in .env files or CI.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <CredentialInventory
          deprecatedEnvVars={statusDeprecatedEnvVars}
          highlightedSlotId={highlight?.slotId}
          highlightNonce={highlight?.nonce ?? 0}
          statusError={statusError}
          statusProviderKeySources={statusProviderKeySources}
        />
        <EnvironmentSection
          deprecatedEnvVars={statusDeprecatedEnvVars}
          onRevealPath={onRevealPath}
          onSelectCredentialSlot={selectCredentialSlot}
        />
      </CardContent>
    </Card>
  );
}

export default ApiKeysSettings;
