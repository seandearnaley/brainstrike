import {
  type NativeIndexMode,
  type NativeLocalSelection,
  validateNativeIndexMode,
  validateNativeLocalSelection,
} from '@brainstrike/indexing-contract/indexer-producer';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

export const NATIVE_INDEX_SETTINGS_KEY = 'background-indexing-preferences.v1';
export interface NativeIndexSettings {
  readonly enabled: boolean;
  readonly indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  readonly managedCollectionId: string;
  readonly mode: NativeIndexMode;
  readonly paused: boolean;
  readonly selection: NativeLocalSelection | null;
  readonly worktreeOptIns: ReadonlySet<string>;
}
/** Read the same durable settings the visible UI writes; missing choices remain unavailable. */
export function readNativeIndexSettings(value: string | null): NativeIndexSettings {
  if (value === null) {
    throw new NativeIndexSetupRequiredError('Choose a search mode in Search & Indexing settings.');
  }
  const state = readPreferenceState(value);
  const managedCollectionId: unknown = Reflect.get(state, 'managedCollectionId');
  const enabled: unknown = Reflect.get(state, 'enabled');
  const paused: unknown = Reflect.get(state, 'paused');
  const indexingPolicyPreset: unknown = Reflect.get(state, 'indexingPolicyPreset');
  if (
    !isOptionalCollectionId(managedCollectionId) ||
    typeof enabled !== 'boolean' ||
    typeof paused !== 'boolean' ||
    (indexingPolicyPreset !== 'balanced' && indexingPolicyPreset !== 'full-root')
  ) {
    throw new Error(
      'Native indexing requires a saved collection, policy and enabled/pause choice.'
    );
  }
  const selected: unknown = Reflect.get(state, 'nativeLocalSelection');
  const selection =
    selected === null || selected === undefined ? null : validateNativeLocalSelection(selected);
  const mode = validateNativeIndexMode(Reflect.get(state, 'nativeIndexMode'));
  if (mode === null) {
    throw new NativeIndexSetupRequiredError('Choose a search mode in Search & Indexing settings.');
  }
  if (managedCollectionId === null || managedCollectionId === undefined) {
    throw new NativeIndexSetupRequiredError(
      'Choose an embedding model and collection in Search & Indexing settings.'
    );
  }
  const optIns: unknown = Reflect.get(state, 'worktreeRootIndexingOptInById');
  const worktreeOptIns = readWorktreeOptIns(optIns);
  return {
    enabled,
    indexingPolicyPreset,
    managedCollectionId,
    mode,
    paused,
    selection,
    worktreeOptIns,
  };
}

function isOptionalCollectionId(value: unknown): value is string | null | undefined {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim().length > 0)
  );
}

function readWorktreeOptIns(optIns: unknown): ReadonlySet<string> {
  const worktreeOptIns = new Set<string>();
  if (optIns && typeof optIns === 'object' && !Array.isArray(optIns)) {
    for (const [id, optedIn] of Object.entries(optIns)) {
      if (id.trim() && optedIn === true) {
        worktreeOptIns.add(id);
      }
    }
  }
  return worktreeOptIns;
}

function readPreferenceState(value: string): object {
  const envelope: unknown = JSON.parse(value);
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Native index preferences are invalid.');
  }
  const state: unknown = Reflect.get(envelope, 'state');
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Native index preferences have no state.');
  }
  return state;
}

/** Cleanup reads the durable collection choice independently of incomplete new inference choices. */
export function readNativeManagedCollectionId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const id: unknown = Reflect.get(readPreferenceState(value), 'managedCollectionId');
  if (id === null) {
    return null;
  }
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Saved native collection identity is invalid.');
  }
  return id;
}

/** Pause changes source admission only; all other choices define the retained authority. */
export function nativeIndexConfigurationIdentity(settings: NativeIndexSettings): string {
  return JSON.stringify([
    settings.enabled,
    settings.indexingPolicyPreset,
    settings.managedCollectionId,
    settings.mode,
    settings.selection,
    [...settings.worktreeOptIns].sort(),
  ]);
}
