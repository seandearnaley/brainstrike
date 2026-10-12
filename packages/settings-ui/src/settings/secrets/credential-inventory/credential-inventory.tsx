import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import {
  createStoredKeyFingerprint,
  type DeprecatedEnvVarReport,
  type ProviderAuthMode,
  type ProviderCredential,
  type ProviderKeySource,
  parseProviderKeySources,
} from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { Table, TableBody, TableHead, TableHeader, TableRow, useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { CredentialLoadError } from '../credential-load-error';
// Parsing rules are shared with the Provider Hub page so the two readers of
// the same listing cannot disagree about what it means (BST-1358).
import {
  invalidCredentialStatus,
  isAllowedProviderEnvVar,
  allowedProviderKeyIds as listAllowedProviderKeyIds,
} from '../credential-source-rules';
import type { CredentialSourceState } from '../provider-key-types';
import { getSecretsCapability } from '../provider-key-types';
import { useCredentialMutations } from '../use-credential-mutations';
import { CredentialRow } from './credential-row';
import { type CredentialSlot, listCredentialSlots } from './credential-slots';

// Frozen module constants back the prop defaults so a caller omitting them
// gets the SAME reference every render — otherwise each render would allocate
// fresh arrays and defeat every memo keyed on these props.
const EMPTY_DEPRECATED_ENV_VARS: readonly DeprecatedEnvVarReport[] = Object.freeze([]);
const EMPTY_STATUS_PROVIDER_KEY_SOURCES: readonly ProviderKeySource<SupportedProvider>[] =
  Object.freeze([]);

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Credential status could not be loaded.';
}

interface EditorDraft {
  readonly key: string;
  /** aws slots only; ignored for api_key slots (BST-1353). */
  readonly mode: ProviderAuthMode;
  readonly profile: string;
  readonly region: string;
  readonly slotId: string;
}

interface InventoryState {
  /** Slot-keyed busy flags: concurrent mutations on different rows never
   * clear each other (a finish event removes only its OWN slot id). */
  readonly busySlotIds: ReadonlySet<string>;
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
  | { type: 'SET_DRAFT_MODE'; mode: ProviderAuthMode }
  | { type: 'SET_DRAFT_PROFILE'; profile: string }
  | { type: 'SET_DRAFT_REGION'; region: string }
  | { type: 'MUTATION_STARTED'; slotId: string }
  | { type: 'MUTATION_FINISHED'; slotId: string }
  | { type: 'SAVE_SUCCESS'; slotId: string };

function withoutSlot(slotIds: ReadonlySet<string>, slotId: string): ReadonlySet<string> {
  const next = new Set(slotIds);
  next.delete(slotId);
  return next;
}

/** Whether the freshly loaded listing reports the open editor's slot as
 * env-sourced. The editor must then close: env is authoritative and the row
 * locks read-only, so a lingering editor could only produce a dead save. */
function editorSlotBecameEnv(
  editor: EditorDraft | null,
  sources: readonly ProviderKeySource<string>[]
): boolean {
  if (!editor) {
    return false;
  }
  return sources.some((source) => source.provider === editor.slotId && source.source === 'env');
}

function inventoryReducer(state: InventoryState, action: InventoryAction): InventoryState {
  switch (action.type) {
    case 'SOURCE_LOAD_STARTED':
      return { ...state, loadError: null, sourceState: 'loading' };
    case 'SOURCE_LOAD_SUCCEEDED':
      return {
        ...state,
        editor: editorSlotBecameEnv(state.editor, action.sources) ? null : state.editor,
        loadError: null,
        sourceState: 'ready',
        sources: action.sources,
      };
    case 'SOURCE_LOAD_FAILED':
      return { ...state, loadError: action.message, sourceState: 'error' };
    case 'OPEN_EDITOR':
      return {
        ...state,
        // Bearer is the default aws mode: it is the form that works with no
        // local AWS setup at all, so it stays the zero-config starting point.
        editor: { key: '', mode: 'bearer', profile: '', region: '', slotId: action.slotId },
      };
    case 'CLOSE_EDITOR':
      return { ...state, editor: null };
    case 'SET_DRAFT_KEY':
      return state.editor ? { ...state, editor: { ...state.editor, key: action.key } } : state;
    case 'SET_DRAFT_MODE':
      return state.editor ? { ...state, editor: { ...state.editor, mode: action.mode } } : state;
    case 'SET_DRAFT_PROFILE':
      return state.editor
        ? { ...state, editor: { ...state.editor, profile: action.profile } }
        : state;
    case 'SET_DRAFT_REGION':
      return state.editor
        ? { ...state, editor: { ...state.editor, region: action.region } }
        : state;
    case 'MUTATION_STARTED':
      return { ...state, busySlotIds: new Set(state.busySlotIds).add(action.slotId) };
    case 'MUTATION_FINISHED':
      return { ...state, busySlotIds: withoutSlot(state.busySlotIds, action.slotId) };
    case 'SAVE_SUCCESS':
      return {
        ...state,
        busySlotIds: withoutSlot(state.busySlotIds, action.slotId),
        // Only the SAVED slot's editor closes — a different row's open draft
        // (opened while this save was in flight) survives untouched.
        editor: state.editor?.slotId === action.slotId ? null : state.editor,
      };
    default:
      return state;
  }
}

function buildCredential(slot: CredentialSlot, draft: EditorDraft): ProviderCredential {
  // A subscription slot has no secret to store — its tokens live in the
  // desktop OAuth engine and never cross into this table. Reaching here means
  // an oauth row somehow opened the editor, and falling through to the
  // api_key return would write an empty key to the keychain under a provider
  // id that can never read it (BST-1356).
  if (slot.authType === 'oauth_subscription') {
    throw new Error(
      `Credential slot "${slot.id}" authenticates by sign-in and stores no credential here.`
    );
  }
  const key = draft.key.trim();
  const region = draft.region.trim();
  // A profile chain holds NO secret — the credentials live in the user's AWS
  // configuration, not ours. So it carries no `…last4` fingerprint, and
  // fingerprinting is skipped entirely rather than run on a non-secret
  // (createStoredKeyFingerprint throws on an empty string by design).
  if (slot.authType === 'aws' && draft.mode === 'profile_chain') {
    const profile = draft.profile.trim();
    return {
      mode: 'profile_chain',
      region,
      type: 'aws',
      ...(profile ? { profile } : {}),
    };
  }
  // The non-secret {last4, savedAt} fingerprint is computed HERE, at save
  // time, from the value being saved — never derived from stored material
  // later (BST-1362). Secrets shorter than eight characters yield no
  // fingerprint at all (the creator's floor): the credential then carries no
  // metadata and the row shows a plain Stored badge without a hint.
  const fingerprint = createStoredKeyFingerprint(key);
  const metadata = fingerprint ? { ...fingerprint } : undefined;
  if (slot.authType === 'aws') {
    return {
      bearerKey: key,
      mode: 'bearer',
      region,
      type: 'aws',
      ...(metadata ? { metadata } : {}),
    };
  }
  return { key, type: 'api_key', ...(metadata ? { metadata } : {}) };
}

export interface CredentialInventoryProps {
  /** Deprecated env names found set, from the assistant status probe (BST-1361). */
  readonly deprecatedEnvVars?: readonly DeprecatedEnvVarReport[] | undefined;
  /** Slot the Environment section cross-linked to (BST-1363): scrolled to and ringed. */
  readonly highlightedSlotId?: string | undefined;
  /** Bumped per cross-link activation so re-targeting the same slot re-scrolls (BST-1363). */
  readonly highlightNonce?: number | undefined;
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
  deprecatedEnvVars = EMPTY_DEPRECATED_ENV_VARS,
  highlightNonce = 0,
  highlightedSlotId,
  providers,
  statusError,
  statusProviderKeySources = EMPTY_STATUS_PROVIDER_KEY_SOURCES,
}: CredentialInventoryProps = {}) {
  const { toast } = useToast();
  const notifySecretsChanged = useSecretsStore((state) => state.notifySecretsChanged);

  // listCredentialSlots reads the frozen registry constant; only the derived
  // allocations need memos.
  const allSlots = useMemo(() => listCredentialSlots(), []);
  const visibleSlots = useMemo(() => {
    if (!providers) {
      return allSlots;
    }
    // The filter predicate is a membership test, so the allow-list becomes a
    // Set once instead of being rescanned for every slot.
    const allowed = new Set(providers);
    return allSlots.filter((slot) => allowed.has(slot.id));
  }, [allSlots, providers]);
  // The listing may legitimately mention providers the table does not show —
  // a stored entry for a keyless local runtime (e.g. ollama) simply has no
  // row. The allowed set is therefore EVERY provider the bridge can emit:
  // the UNFILTERED registry plus Tavily, independent of slot filtering —
  // matching assistant-preferences-store's CONFIGURED_KEY_PROVIDER_IDS so the
  // two strict consumers of the shared parser cannot drift.
  const allowedProviderKeyIds = useMemo(() => listAllowedProviderKeyIds(), []);

  const [state, dispatch] = useReducer(inventoryReducer, {
    busySlotIds: new Set<string>(),
    editor: null,
    loadError: null,
    sourceState: 'loading',
    sources: [],
  });
  const { busySlotIds, editor, loadError, sources, sourceState } = state;

  // Grouped ONCE per payload change — the per-row alternative (filtering the
  // full report list inside every row render) is quadratic in slot count.
  const deprecationsBySlotId = useMemo(() => {
    const grouped = new Map<string, DeprecatedEnvVarReport[]>();
    for (const report of deprecatedEnvVars) {
      const existing = grouped.get(report.provider);
      if (existing) {
        existing.push(report);
      } else {
        grouped.set(report.provider, [report]);
      }
    }
    return grouped;
  }, [deprecatedEnvVars]);

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
      // Symmetric with handleRemove's stored-guard: an env source is
      // authoritative and its row is read-only, so a Save racing an env
      // source appearing must never write to the keychain — the stale
      // editor just closes (BST-1362 review).
      if (mergedSources.get(slot.id)?.source === 'env') {
        dispatch({ type: 'CLOSE_EDITOR' });
        return;
      }
      // Profile-chain saves require only a region — the profile is optional
      // (blank means the chain's default) and there is no secret to demand.
      const isProfileChain = slot.authType === 'aws' && editor.mode === 'profile_chain';
      const key = editor.key.trim();
      const region = editor.region.trim();
      if (slot.authType === 'aws' && !region) {
        return;
      }
      if (!(key || isProfileChain)) {
        return;
      }
      dispatch({ slotId: slot.id, type: 'MUTATION_STARTED' });
      const saved = await saveCredential(slot.id, buildCredential(slot, editor));
      dispatch({ slotId: slot.id, type: saved ? 'SAVE_SUCCESS' : 'MUTATION_FINISHED' });
    },
    [editor, mergedSources, saveCredential]
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
      dispatch({ slotId: slot.id, type: 'MUTATION_FINISHED' });
    },
    [deleteSecret, mergedSources]
  );

  const visibleErrors = [...new Set([statusError, loadError].filter(Boolean))].join(' ');

  return (
    <div className="space-y-3">
      <CredentialLoadError message={visibleErrors} />
      {/* Auto layout: the column widths are preferences, never narrower than
          their content, so two row actions cannot spill over the Key column
          (a fixed 16% Actions column did at 1536px, BST-1981). */}
      <Table aria-label="Credential inventory" className="table-auto">
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
              busy={busySlotIds.has(slot.id)}
              deprecatedReports={deprecationsBySlotId.get(slot.id) ?? EMPTY_DEPRECATED_ENV_VARS}
              draftKey={editor?.slotId === slot.id ? editor.key : ''}
              draftMode={editor?.slotId === slot.id ? editor.mode : 'bearer'}
              draftProfile={editor?.slotId === slot.id ? editor.profile : ''}
              draftRegion={editor?.slotId === slot.id ? editor.region : ''}
              editing={editor?.slotId === slot.id}
              highlighted={highlightedSlotId === slot.id}
              highlightNonce={highlightNonce}
              key={slot.id}
              onCancelEdit={() => dispatch({ type: 'CLOSE_EDITOR' })}
              onDraftKeyChange={(key) => dispatch({ key, type: 'SET_DRAFT_KEY' })}
              onDraftModeChange={(mode) => dispatch({ mode, type: 'SET_DRAFT_MODE' })}
              onDraftProfileChange={(profile) => dispatch({ profile, type: 'SET_DRAFT_PROFILE' })}
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
