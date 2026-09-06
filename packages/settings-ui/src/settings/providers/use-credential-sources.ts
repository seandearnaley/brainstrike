import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import { type ProviderKeySource, parseProviderKeySources } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  allowedProviderKeyIds,
  invalidCredentialStatus,
  isAllowedProviderEnvVar,
} from '../secrets/credential-source-rules';
import { getSecretsCapability } from '../secrets/provider-key-types';
import type { ProviderSourceState } from './provider-connection';

const EMPTY_STATUS_SOURCES: readonly ProviderKeySource<SupportedProvider>[] = Object.freeze([]);
const EMPTY_SOURCES: ReadonlyMap<string, ProviderKeySource<string>> = new Map();

/** Sentinel for "no listing has completed yet" — never a real version. */
const UNREAD_VERSION = -1;

export interface CredentialSourcesResult {
  /**
   * Whether this build can WRITE credentials. False on web, where the only
   * source is the server environment — the capability check IS the platform
   * gate (never `isElectron()`).
   */
  readonly editable: boolean;
  readonly error: string;
  readonly sourcesBySlotId: ReadonlyMap<string, ProviderKeySource<string>>;
  readonly state: ProviderSourceState;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Credential status could not be loaded.';
}

/**
 * Page-level view of which credential each provider will actually authenticate
 * with — the header state behind every Provider Hub card (BST-1358).
 *
 * This is a SECOND reader of the same `secrets.list()` payload the Credential
 * Inventory table reads. That is deliberate: the table owns per-row editing
 * state and re-reads on its own mutations, while the page needs one map across
 * ALL providers for card headers, sorting and the empty state. Both parse
 * through `credential-source-rules`, so they cannot disagree about what the
 * payload means; only the fetch is duplicated, and it is a local IPC listing
 * refreshed on the same `secretsVersion` signal.
 *
 * A failed listing reports `error` and keeps the map EMPTY with state
 * `'error'` — callers must render "unknown", never "not set" (NO SILENT
 * FALLBACKS).
 */
export function useCredentialSources(
  statusProviderKeySources: readonly ProviderKeySource<SupportedProvider>[] = EMPTY_STATUS_SOURCES
): CredentialSourcesResult {
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);
  // The preload bridge cannot appear mid-session, so it is resolved once; its
  // presence is the capability gate for editing.
  const listCredentials = useMemo(() => getSecretsCapability()?.list, []);
  const [listed, setListed] = useState<{
    readonly error: string;
    readonly settled: 'error' | 'ready';
    readonly sources: readonly ProviderKeySource<string>[];
    /** The `secretsVersion` this listing describes. */
    readonly version: number;
  }>({ error: '', settled: 'ready', sources: [], version: UNREAD_VERSION });
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!listCredentials) {
      return;
    }
    // Generation guard, matching local-runtime-settings-section: a response
    // from a superseded read must never overwrite a newer one, and unmount
    // invalidates every outstanding read.
    const generation = ++requestGeneration.current;
    const isStale = () => generation !== requestGeneration.current;
    listCredentials()
      .then((payload) => {
        if (isStale()) {
          return;
        }
        setListed({
          error: '',
          settled: 'ready',
          sources: parseProviderKeySources<string>(payload, {
            allowedProviders: allowedProviderKeyIds(),
            invalidPayload: invalidCredentialStatus,
            isAllowedEnvVar: isAllowedProviderEnvVar,
          }),
          version: secretsVersion,
        });
      })
      .catch((error: unknown) => {
        if (isStale()) {
          return;
        }
        setListed({
          error: toErrorMessage(error),
          settled: 'error',
          sources: [],
          version: secretsVersion,
        });
      });
    return () => {
      requestGeneration.current += 1;
    };
  }, [listCredentials, secretsVersion]);

  // `loading` is DERIVED from "the newest listing predates the current
  // secrets version", so the effect never has to write a loading state.
  //
  // With NO bridge, the status payload is the only possible source of truth.
  // When the host passes none — which is exactly what the web settings page
  // does — the honest answer is `unavailable`, not `ready`: reporting `ready`
  // turned "we cannot read credentials here" into "every provider is
  // disconnected", behind a first-run panel that could never be dismissed.
  const state: ProviderSourceState = listCredentials
    ? listed.version === secretsVersion
      ? listed.settled
      : 'loading'
    : statusProviderKeySources.length > 0
      ? 'ready'
      : 'unavailable';

  const sourcesBySlotId = useMemo(() => {
    if (state === 'error') {
      // An errored listing must not be blended with status data — a partial
      // map would read as authoritative.
      return EMPTY_SOURCES;
    }
    const merged = new Map<string, ProviderKeySource<string>>();
    for (const source of listed.sources) {
      merged.set(source.provider, source);
    }
    // Same precedence the inventory applies: an env source is authoritative
    // wherever it appears; a status stored source only fills a gap.
    for (const source of statusProviderKeySources) {
      const existing = merged.get(source.provider);
      if (source.source === 'env' || !existing) {
        merged.set(source.provider, source);
      }
    }
    return merged;
  }, [listed.sources, state, statusProviderKeySources]);

  return {
    editable: Boolean(listCredentials),
    error: state === 'error' ? listed.error : '',
    sourcesBySlotId,
    state,
  };
}
