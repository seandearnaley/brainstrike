// @vitest-environment node
import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import { describe, expect, it } from 'vitest';
import {
  nativeIndexConfigurationIdentity,
  nativeIndexSettingsFromConfig,
} from '../src/index-settings.js';

const model = {
  dimensions: 384,
  local: { device: 'wasm', dtype: 'q8' },
  modelKey: 'transformers::Xenova/bge-small-en-v1.5',
} as const;

describe('native index settings from the saved config', () => {
  it('runs a fresh profile as text search over its workspace folders', () => {
    expect(nativeIndexSettingsFromConfig(DEFAULT_INDEX_CONFIG, null)).toEqual({
      chunking: { _tag: 'Auto' },
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'TEXT',
      paused: false,
      selection: null,
      worktreeOptIns: new Set(),
    });
  });

  it('runs semantic search in the vector space Main ensured, on the chosen device', () => {
    const settings = nativeIndexSettingsFromConfig(
      { ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model, worktrees: { wt1: true, wt2: false } },
      'space-1'
    );
    expect(settings).toMatchObject({
      managedCollectionId: 'space-1',
      mode: 'VECTOR',
      selection: {
        device: 'wasm',
        dimensions: 384,
        dtype: 'q8',
        modelId: 'Xenova/bge-small-en-v1.5',
      },
      worktreeOptIns: new Set(['wt1']),
    });
  });

  it('turns indexing off while keeping the chosen model', () => {
    expect(
      nativeIndexSettingsFromConfig({ ...DEFAULT_INDEX_CONFIG, mode: 'off', model }, null)
    ).toMatchObject({ enabled: false, managedCollectionId: null, mode: 'TEXT' });
  });

  it('refuses semantic search without its vector space', () => {
    expect(() =>
      nativeIndexSettingsFromConfig({ ...DEFAULT_INDEX_CONFIG, mode: 'semantic', model }, null)
    ).toThrow('Semantic search has no vector space');
  });

  it('treats a chunking change as a new configuration, and pause as the same one', () => {
    const base = nativeIndexSettingsFromConfig(DEFAULT_INDEX_CONFIG, null);
    const custom = nativeIndexSettingsFromConfig(
      { ...DEFAULT_INDEX_CONFIG, chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 } },
      null
    );
    const paused = nativeIndexSettingsFromConfig({ ...DEFAULT_INDEX_CONFIG, paused: true }, null);
    expect(nativeIndexConfigurationIdentity(custom)).not.toBe(
      nativeIndexConfigurationIdentity(base)
    );
    expect(nativeIndexConfigurationIdentity(paused)).toBe(nativeIndexConfigurationIdentity(base));
  });
});
