import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAssistantSubagentPreferencesStoreForTests,
  useAssistantSubagentPreferencesStore,
} from '../stores/assistant-subagent-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useAssistantSubagentPreferencesStore as PersistApi<
  typeof useAssistantSubagentPreferencesStore
>;

describe('assistant subagent preferences store', () => {
  afterEach(() => {
    __resetAssistantSubagentPreferencesStoreForTests();
  });

  it('defaults to the contract defaults', () => {
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('stores each field independently', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    store.setMaxChildSteps(48);
    store.setSynthesisOutputTokens(4096);
    store.setMaxChildOutputTokens(65_536);
    store.setMaxStepOutputTokens(16_384);
    store.setMaxDepth(5);
    store.setMaxInvocations(40);
    store.setMaxConcurrentWork(3);
    store.setMaxTreeOutputTokens(262_144);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      maxChildOutputTokens: 65_536,
      maxChildRuntimeMs: null,
      maxChildSteps: 48,
      maxConcurrentWork: 3,
      maxDepth: 5,
      maxInvocations: 40,
      maxStepOutputTokens: 16_384,
      maxTreeOutputTokens: 262_144,
      synthesisOutputTokens: 4096,
    });
  });

  it('THROWS on an out-of-range tree limit and on a tree output budget below the child budget', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    expect(() => store.setMaxDepth(9)).toThrow(/maxDepth/);
    expect(() => store.setMaxInvocations(0)).toThrow(/maxInvocations/);
    expect(() => store.setMaxConcurrentWork(21)).toThrow(/maxConcurrentWork/);
    // Default child output is 32,768: the tree budget cannot drop below it.
    expect(() => store.setMaxTreeOutputTokens(16_384)).toThrow(
      /maxChildOutputTokens must not exceed maxTreeOutputTokens/
    );
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('THROWS on an out-of-range or non-integer value and lands nothing', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    for (const invalid of [0, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.setMaxChildSteps(invalid)).toThrow(/Subagent settings are malformed/);
    }
    expect(() => store.setSynthesisOutputTokens(255)).toThrow(/synthesisOutputTokens/);
    // Cross-field: a synthesis reservation cannot exceed the child's whole budget.
    store.setSynthesisOutputTokens(512);
    store.setMaxStepOutputTokens(512);
    store.setMaxChildOutputTokens(1024);
    expect(() => store.setSynthesisOutputTokens(2048)).toThrow(/must not exceed/);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxChildOutputTokens: 1024,
      maxStepOutputTokens: 512,
      synthesisOutputTokens: 512,
    });
  });

  it('refuses a child output budget below the current synthesis or step budget', () => {
    // Defaults: synthesis 2048 and step 8192 both exceed 1024, so the write is
    // refused rather than silently shrinking them.
    const store = useAssistantSubagentPreferencesStore.getState();
    expect(() => store.setMaxChildOutputTokens(1024)).toThrow(/must not exceed/);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('sanitizes malformed persisted data at the current version back to defaults', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    if (options.version === undefined) {
      throw new Error('persist version unavailable for test');
    }
    options.storage.setItem(options.name, {
      state: { settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 1001 } },
      version: options.version,
    });
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('rehydrates a valid persisted value', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    if (options.version === undefined) {
      throw new Error('persist version unavailable for test');
    }
    const settings = { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 12 };
    options.storage.setItem(options.name, { state: { settings }, version: options.version });
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(settings);
  });

  it('sets a runtime limit and turns it back Off, refusing a timer Node would fire at once', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    store.setMaxChildRuntimeMs(3_600_000);
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBe(
      3_600_000
    );
    for (const invalid of [999, 2 ** 31, Number.POSITIVE_INFINITY]) {
      expect(() => store.setMaxChildRuntimeMs(invalid)).toThrow(/Subagent settings are malformed/);
    }
    store.setMaxChildRuntimeMs(null);
    expect(useAssistantSubagentPreferencesStore.getState().settings.maxChildRuntimeMs).toBeNull();
  });

  it('carries every v1 budget across the upgrade and starts the new runtime limit Off', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    // A v1 payload predates `maxChildRuntimeMs`; the strict schema alone would
    // reject it and silently reset the user's saved budgets to defaults.
    const v1 = {
      maxChildOutputTokens: 65_536,
      maxChildSteps: 32,
      maxStepOutputTokens: 8192,
      synthesisOutputTokens: 8192,
    };
    options.storage.setItem(options.name, { state: { settings: v1 }, version: 1 });
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      ...v1,
      maxChildRuntimeMs: null,
    });
  });

  it('carries every v2 budget across the upgrade and starts the tree limits at their defaults', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    expect(options.version).toBe(3);
    // A v2 payload predates the tree limits (they were host constants).
    const v2 = {
      maxChildOutputTokens: 131_072,
      maxChildRuntimeMs: 5_400_000,
      maxChildSteps: 640,
      maxStepOutputTokens: 16_384,
      synthesisOutputTokens: 4096,
    };
    options.storage.setItem(options.name, { state: { settings: v2 }, version: 2 });
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...v2,
      maxConcurrentWork: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxConcurrentWork,
      maxDepth: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxDepth,
      maxInvocations: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxInvocations,
      maxTreeOutputTokens: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxTreeOutputTokens,
    });
  });

  it('resets to defaults', () => {
    useAssistantSubagentPreferencesStore.getState().setMaxChildSteps(5);
    useAssistantSubagentPreferencesStore.getState().resetToDefaults();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });
});
