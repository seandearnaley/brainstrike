import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import {
  createStoredKeyFingerprint,
  type DeprecatedEnvVarReport,
  type ProviderCredential,
  type ProviderKeySource,
  parseProviderKeySources,
} from '@brainstrike/assistant-contract';
import {
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { Table, TableBody, TableHead, TableHeader, TableRow, useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { CredentialLoadError } from '../credential-load-error';
import type { CredentialSourceState } from '../provider-key-types';
import { getSecretsCapability, TAVILY_SECRET_PROVIDER } from '../provider-key-types';
import { useCredentialMutations } from '../use-credential-mutations';
import { CredentialRow } from './credential-row';
import { type CredentialSlot, listCredentialSlots } from './credential-slots';

const TAVILY_ENV_KEYS = new Set(['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY']);

function invalidCredentialStatus(): Error {
  return new Error('The desktop returned invalid credential status metadata.');
}

function isAllowedProviderEnvVar(provider: string, envVar: string): boolean {
  if (provider === TAVILY_SECRET_PROVIDER) {
    return TAVILY_ENV_KEYS.has(envVar);
  }
  return providerEnvKeys(provider as SupportedProvider).includes(envVar);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Credential status could not be loaded.';
}

interface EditorDraft {
  readonly key: string;
  readonly region: string;
  readonly slotId: string;
}

interface InventoryState {
  readonly busySlotId: string | null;
  readonly editor: EditorDraft | null;
  readonly loadError: string | null;
  readonly sourceState: CredentialSourceState;
  readonly sources: ProviderKeySource<string>[];
}

type InventoryAction =
  | { type: 'SOURCE_LOAD_STARTED' }
  | { type: 'SOURCE_LOAD_SUCCEEDED'; sources: ProviderKeySource<string>[] }
  | { type: 'SOURCE_LOAD_FAILED'; message: string }
  | { type: 'OPEN_EDITOR'; slotId: string }
  | { type: 'CLOSE_EDITOR' }
  | { type: 'SET_DRAFT_KEY'; key: string }
  | { type: 'SET_DRAFT_REGION'; region: string }
  | { type: 'MUTATION_STARTED'; slotId: string }
  | { type: 'MUTATION_FINISHED' }
  | { type: 'SAVE_SUCCESS' };

function inventoryReducer(state: InventoryState, action: InventoryAction): InventoryState {
  switch (action.type) {
    case 'SOURCE_LOAD_STARTED':
      return { ...state, loadError: null, sourceState: 'loading' };
    case 'SOURCE_LOAD_SUCCEEDED':
      return { ...state, loadError: null, sourceState: 'ready', sources: action.sources };
    case 'SOURCE_LOAD_FAILED':
      return { ...state, loadError: action.message, sourceState: 'error' };
    case 'OPEN_EDITOR':
      return { ...state, editor: { key: '', region: '', slotId: action.slotId } };
    case 'CLOSE_EDITOR':
      return { ...state, editor: null };
    case 'SET_DRAFT_KEY':
      return state.editor ? { ...state, editor: { ...state.editor, key: action.key } } : state;
    case 'SET_DRAFT_REGION':
      return state.editor
        ? { ...state, editor: { ...state.editor, region: action.region } }
        : state;
    case 'MUTATION_STARTED':
      return { ...state, busySlotId: action.slotId };
    case 'MUTATION_FINISHED':
      return { ...state, busySlotId: null };
    case 'SAVE_SUCCESS':
      return { ...state, busySlotId: null, editor: null };
    default:
      return state;
  }
}

function buildCredential(slot: CredentialSlot, key: string, region: string): ProviderCredential {
  // The non-secret {last4, savedAt} fingerprint is computed HERE, at save
  // time, from the value being saved — never derived from stored material
  // later (BST-1362).
  const metadata = { ...createStoredKeyFingerprint(key) };
  if (slot.authType === 'aws') {
    return { bearerKey: key, metadata, mode: 'bearer', region, type: 'aws' };
  }
  return { key, metadata, type: 'api_key' };
}

export interface CredentialInventoryProps {
  /** Deprecated env names found set, from the assistant status probe (BST-1361). */
  readonly deprecatedEnvVars?: readonly DeprecatedEnvVarReport[] | undefined;
  /** Optional slot-id filter — `['openai']` renders exactly one row (BST-1358 seam). */
  readonly providers?: readonly string[] | undefined;
  readonly statusError?: string | undefined;
  readonly statusProviderKeySources?: readonly ProviderKeySource<SupportedProvider>[] | undefined;
}

/**
 * The all-keys credential table (BST-1362): one always-visible row per
 * credential slot, inline row editing, read-only env rows, and the save-time
 * `…last4` fingerprint for stored keys. Capability-gated on the desktop
 * secrets bridge — the web build omits the whole category.
 *
 * @platform desktop
 */
export function CredentialInventory({
  deprecatedEnvVars = [],
  providers,
  statusError,
  statusProviderKeySources = [],
}: CredentialInventoryProps = {}) {
  const { toast } = useToast();
  const notifySecretsChanged = useSecretsStore((state) => state.notifySecretsChanged);

  // listCredentialSlots reads the frozen registry constant; only the derived
  // allocations need memos.
  const allSlots = useMemo(() => listCredentialSlots(), []);
  const visibleSlots = useMemo(
    () => (providers ? allSlots.filter((slot) => providers.includes(slot.id)) : allSlots),
    [allSlots, providers]
  );
  // The listing may legitimately mention providers the table does not show
  // (e.g. local-runtime bearer tokens), so the allowed set is every registry
  // provider — the visibility filter never narrows validation.
  const allowedProviderKeyIds = useMemo(
    () => new Set([...allSlots.map((slot) => slot.id), TAVILY_SECRET_PROVIDER]),
    [allSlots]
  );

  const [state, dispatch] = useReducer(inventoryReducer, {
    busySlotId: null,
    editor: null,
    loadError: null,
    sourceState: 'loading',
    sources: [],
  });
  const { busySlotId, editor, loadError, sources, sourceState } = state;

  const mergedSources = useMemo(() => {
    const merged = new Map<string, ProviderKeySource<string>>();
    for (const source of sources) {
      merged.set(source.provider, source);
    }
    // Status-probe seed: an env source is authoritative wherever it appears;
    // a status stored source only fills a gap (the IPC stored entry carries
    // the fingerprint the status payload lacks).
    for (const source of statusProviderKeySources) {
      const existing = merged.get(source.provider);
      if (source.source === 'env' || !existing) {
        merged.set(source.provider, source);
      }
    }
    return merged;
  }, [sources, statusProviderKeySources]);

  const orderedSlots = useMemo(() => {
    const rank = (slot: CredentialSlot): number => {
      const source = mergedSources.get(slot.id);
      if (source?.source === 'stored') {
        return 0;
      }
      if (source?.source === 'env') {
        return 1;
      }
      return 2;
    };
    // Stable sort: configured first (Stored, then Env), then Not set,
    // registry order within each group.
    return [...visibleSlots].sort((a, b) => rank(a) - rank(b));
  }, [mergedSources, visibleSlots]);

  const refresh = useCallback(async () => {
    dispatch({ type: 'SOURCE_LOAD_STARTED' });
    const listFn = getSecretsCapability()?.list;
    if (!listFn) {
      dispatch({
        message: 'Secure credential status is unavailable.',
        type: 'SOURCE_LOAD_FAILED',
      });
      return;
    }
    try {
      const parsed = parseProviderKeySources<string>(await listFn(), {
        allowedProviders: allowedProviderKeyIds,
        invalidPayload: invalidCredentialStatus,
        isAllowedEnvVar: isAllowedProviderEnvVar,
      });
      dispatch({ sources: parsed, type: 'SOURCE_LOAD_SUCCEEDED' });
    } catch (error) {
      dispatch({ message: toErrorMessage(error), type: 'SOURCE_LOAD_FAILED' });
    }
  }, [allowedProviderKeyIds]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { deleteSecret, saveCredential } = useCredentialMutations({
    notifySecretsChanged,
    refresh,
    sourceState,
    toast,
  });

  const handleSave = useCallback(
    async (slot: CredentialSlot) => {
      if (!editor || editor.slotId !== slot.id) {
        return;
      }
      const key = editor.key.trim();
      const region = editor.region.trim();
      if (!key || (slot.authType === 'aws' && !region)) {
        return;
      }
      dispatch({ slotId: slot.id, type: 'MUTATION_STARTED' });
      const saved = await saveCredential(slot.id, buildCredential(slot, key, region));
      dispatch({ type: saved ? 'SAVE_SUCCESS' : 'MUTATION_FINISHED' });
    },
    [editor, saveCredential]
  );

  const handleRemove = useCallback(
    async (slot: CredentialSlot) => {
      // Remove targets a KEYCHAIN entry, so it is only meaningful when one
      // exists; the button only renders on stored rows, this guards races.
      if (mergedSources.get(slot.id)?.source !== 'stored') {
        return;
      }
      dispatch({ slotId: slot.id, type: 'MUTATION_STARTED' });
      await deleteSecret(slot.id);
      dispatch({ type: 'MUTATION_FINISHED' });
    },
    [deleteSecret, mergedSources]
  );

  const visibleErrors = [...new Set([statusError, loadError].filter(Boolean))].join(' ');

  return (
    <div className="space-y-3">
      <CredentialLoadError message={visibleErrors} />
      <Table aria-label="Credential inventory">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[22%]">Name</TableHead>
            <TableHead className="w-[30%]">Variable</TableHead>
            <TableHead className="w-[16%]">Status</TableHead>
            <TableHead className="w-[16%]">Key</TableHead>
            <TableHead className="w-[16%] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orderedSlots.map((slot) => (
            <CredentialRow
              busy={busySlotId === slot.id}
              deprecatedReports={deprecatedEnvVars.filter((report) => report.provider === slot.id)}
              draftKey={editor?.slotId === slot.id ? editor.key : ''}
              draftRegion={editor?.slotId === slot.id ? editor.region : ''}
              editing={editor?.slotId === slot.id}
              key={slot.id}
              onCancelEdit={() => dispatch({ type: 'CLOSE_EDITOR' })}
              onDraftKeyChange={(key) => dispatch({ key, type: 'SET_DRAFT_KEY' })}
              onDraftRegionChange={(region) => dispatch({ region, type: 'SET_DRAFT_REGION' })}
              onOpenEditor={() => dispatch({ slotId: slot.id, type: 'OPEN_EDITOR' })}
              onRemove={() => void handleRemove(slot)}
              onSave={() => void handleSave(slot)}
              slot={slot}
              source={mergedSources.get(slot.id)}
              sourceState={sourceState}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
