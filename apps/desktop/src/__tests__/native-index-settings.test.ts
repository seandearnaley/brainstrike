// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readNativeIndexSettings, readNativeManagedCollectionId } from '../native-index-settings';

const state = {
  enabled: true,
  indexingPolicyPreset: 'balanced',
  managedCollectionId: 'actual-collection',
  nativeIndexMode: 'TEXT',
  nativeLocalSelection: null,
  paused: false,
  worktreeRootIndexingOptInById: { allowed: true, denied: false },
};
const saved = (changes: Record<string, unknown> = {}): string =>
  JSON.stringify({ state: { ...state, ...changes }, version: 6 });

describe('main native indexing settings', () => {
  it('reads collection retirement independently of incomplete new VECTOR choices', () => {
    expect(readNativeManagedCollectionId(saved({ nativeIndexMode: 'VECTOR' }))).toBe(
      'actual-collection'
    );
    expect(readNativeManagedCollectionId(saved({ managedCollectionId: null }))).toBeNull();
    expect(readNativeManagedCollectionId(null)).toBeNull();
    expect(() => readNativeManagedCollectionId(saved({ managedCollectionId: '' }))).toThrow(
      'identity is invalid'
    );
  });
  it('uses the actual saved TEXT collection and explicit worktree opt-ins', () => {
    expect(readNativeIndexSettings(saved())).toMatchObject({
      enabled: true,
      managedCollectionId: 'actual-collection',
      mode: 'TEXT',
      selection: null,
    });
    expect([...readNativeIndexSettings(saved()).worktreeOptIns]).toEqual(['allowed']);
    expect(readNativeIndexSettings(saved({ paused: true }))).toMatchObject({
      enabled: true,
      paused: true,
    });
  });
  it('refuses absent mode, collection and execution choices', () => {
    expect(() => readNativeIndexSettings(null)).toThrow('Choose a search mode');
    expect(() => readNativeIndexSettings(saved({ nativeIndexMode: null }))).toThrow(
      'Choose a search mode'
    );
    expect(() => readNativeIndexSettings(saved({ managedCollectionId: '' }))).toThrow(
      'requires a saved collection'
    );
    expect(readNativeIndexSettings(saved({ nativeIndexMode: 'VECTOR' }))).toMatchObject({
      mode: 'VECTOR',
      selection: null,
    });
  });
  it('retains every full explicit VECTOR execution field', () => {
    const selection = {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    };
    expect(
      readNativeIndexSettings(saved({ nativeIndexMode: 'VECTOR', nativeLocalSelection: selection }))
        .selection
    ).toEqual(selection);
    expect(() =>
      readNativeIndexSettings(
        saved({
          nativeIndexMode: 'VECTOR',
          nativeLocalSelection: { ...selection, revision: 'latest' },
        })
      )
    ).toThrow();
  });
});
