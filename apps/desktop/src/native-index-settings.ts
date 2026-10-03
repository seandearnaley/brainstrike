import {
  type NativeIndexMode,
  type NativeLocalSelection,
  validateNativeIndexMode,
  validateNativeLocalSelection,
} from '@brainstrike/indexing-contract/indexer-producer';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';

export const NATIVE_INDEX_SETTINGS_KEY = 'background-indexing-preferences.v1';
export interface NativeIndexSettings {
  readonly enabled: boolean;
  readonly indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  readonly managedCollectionId: string;
  readonly mode: NativeIndexMode;
  readonly selection: NativeLocalSelection | null;
  readonly worktreeOptIns: ReadonlySet<string>;
}
/** Read the same durable settings the visible UI writes; missing choices remain unavailable. */
export function readNativeIndexSettings(value: string | null): NativeIndexSettings {
  if (value === null) {
    throw new Error('Choose a native search mode in Workspace Index settings.');
  }
  const envelope: unknown = JSON.parse(value);
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Native index preferences are invalid.');
  }
  const state: unknown = Reflect.get(envelope, 'state');
  if (!state || typeof state !== 'object') {
    throw new Error('Native index preferences have no state.');
  }
  const mode = validateNativeIndexMode(Reflect.get(state, 'nativeIndexMode'));
  if (mode === null) {
    throw new Error('Choose a native search mode in Workspace Index settings.');
  }
  const managedCollectionId: unknown = Reflect.get(state, 'managedCollectionId');
  const enabled: unknown = Reflect.get(state, 'enabled');
  const paused: unknown = Reflect.get(state, 'paused');
  const indexingPolicyPreset: unknown = Reflect.get(state, 'indexingPolicyPreset');
  if (
    typeof managedCollectionId !== 'string' ||
    !managedCollectionId.trim() ||
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
  if (mode === 'VECTOR' && selection === null) {
    throw new Error('Semantic indexing requires an explicitly selected local execution plan.');
  }
  const optIns: unknown = Reflect.get(state, 'worktreeRootIndexingOptInById');
  const worktreeOptIns = readWorktreeOptIns(optIns);
  return {
    enabled: enabled && !paused,
    indexingPolicyPreset,
    managedCollectionId,
    mode,
    selection,
    worktreeOptIns,
  };
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
