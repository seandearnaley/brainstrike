import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { describe, expect, it } from 'vitest';
import { useAssistantSubagentPreferencesStore } from '../stores/assistant-subagent-preferences-store.ts';
import type { PersistApi } from './persist-api-test-helper.ts';

const storeWithPersist = useAssistantSubagentPreferencesStore as PersistApi<
  typeof useAssistantSubagentPreferencesStore
>;

describe('assistant subagent preferences store', () => {
  it('defaults to the contract defaults', () => {
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('stores each field independently', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    store.setMaxChildSteps(48);
    store.setSynthesisOutputTokens(4096);
    store.setMaxStepOutputTokens(16_384);
    store.setMaxDepth(5);
    store.setMaxInvocations(40);
    store.setMaxConcurrentWork(3);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      maxChildRuntimeMs: null,
      maxChildSteps: 48,
      maxConcurrentWork: 3,
      maxDepth: 5,
      maxInvocations: 40,
      maxStepOutputTokens: 16_384,
      synthesisOutputTokens: 4096,
    });
  });

  it('THROWS on an out-of-range tree limit and lands nothing', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    expect(() => store.setMaxDepth(9)).toThrow(/maxDepth/u);
    expect(() => store.setMaxInvocations(0)).toThrow(/maxInvocations/u);
    expect(() => store.setMaxConcurrentWork(21)).toThrow(/maxConcurrentWork/u);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('THROWS on an out-of-range or non-integer value and lands nothing', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    for (const invalid of [0, 1001, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.setMaxChildSteps(invalid)).toThrow(/Subagent settings are malformed/u);
    }
    expect(() => store.setSynthesisOutputTokens(255)).toThrow(/synthesisOutputTokens/u);
    expect(() => store.setMaxStepOutputTokens(65_537)).toThrow(/maxStepOutputTokens/u);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
  });

  it('sets an output cap and turns it back Off', () => {
    const store = useAssistantSubagentPreferencesStore.getState();
    store.setMaxStepOutputTokens(4096);
    store.setSynthesisOutputTokens(1024);
    expect(useAssistantSubagentPreferencesStore.getState().settings).toMatchObject({
      maxStepOutputTokens: 4096,
      synthesisOutputTokens: 1024,
    });
    store.setMaxStepOutputTokens(null);
    store.setSynthesisOutputTokens(null);
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
    localStorage.setItem(
      options.name,
      JSON.stringify({
        state: { settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 1001 } },
        version: options.version,
      })
    );
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
    localStorage.setItem(
      options.name,
      JSON.stringify({ state: { settings }, version: options.version })
    );
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
      expect(() => store.setMaxChildRuntimeMs(invalid)).toThrow(/Subagent settings are malformed/u);
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
      maxStepOutputTokens: 4096,
      synthesisOutputTokens: 8192,
    };
    localStorage.setItem(options.name, JSON.stringify({ state: { settings: v1 }, version: 1 }));
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxChildRuntimeMs: null,
      maxChildSteps: 32,
      maxStepOutputTokens: 4096,
      synthesisOutputTokens: 8192,
    });
  });

  it('carries every v2 budget across the upgrade and starts the tree limits at their defaults', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    // A v2 payload predates the tree limits (they were host constants).
    const v2 = {
      maxChildOutputTokens: 131_072,
      maxChildRuntimeMs: 5_400_000,
      maxChildSteps: 640,
      maxStepOutputTokens: 16_384,
      synthesisOutputTokens: 4096,
    };
    localStorage.setItem(options.name, JSON.stringify({ state: { settings: v2 }, version: 2 }));
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      maxChildRuntimeMs: 5_400_000,
      maxChildSteps: 640,
      maxConcurrentWork: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxConcurrentWork,
      maxDepth: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxDepth,
      maxInvocations: DEFAULT_RUNTIME_SUBAGENT_SETTINGS.maxInvocations,
      maxStepOutputTokens: 16_384,
      synthesisOutputTokens: 4096,
    });
  });

  it('turns v3 output caps left at the old defaults Off and drops the unenforced budgets', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name && storeWithPersist.persist?.rehydrate)) {
      throw new Error('persist storage unavailable for test');
    }
    expect(options.version).toBe(4);
    const v3 = {
      maxChildOutputTokens: 32_768,
      maxChildRuntimeMs: null,
      maxChildSteps: 100,
      maxConcurrentWork: 6,
      maxDepth: 3,
      maxInvocations: 200,
      maxStepOutputTokens: 8192,
      maxTreeOutputTokens: 6_553_600,
      synthesisOutputTokens: 2048,
    };
    localStorage.setItem(options.name, JSON.stringify({ state: { settings: v3 }, version: 3 }));
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual(
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
    // A cap the user chose carries over.
    localStorage.setItem(
      options.name,
      JSON.stringify({ state: { settings: { ...v3, maxStepOutputTokens: 4096 } }, version: 3 })
    );
    await storeWithPersist.persist.rehydrate();
    expect(useAssistantSubagentPreferencesStore.getState().settings).toEqual({
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxStepOutputTokens: 4096,
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
