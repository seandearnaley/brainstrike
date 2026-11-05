import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbModel, useModelRegistryStore } from '../stores/model-registry-store.ts';
import { __resetSettingsTestOverridesForTests } from './settings-test-overrides-test-helper.ts';

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

function model(id: string, isEnabled: boolean): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    id,
    isEnabled,
    name: id,
    parameters: null,
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
  };
}

function enabledStates(): Record<string, boolean> {
  return Object.fromEntries(
    useModelRegistryStore.getState().models.map((entry) => [entry.id, entry.isEnabled])
  );
}

describe('model-registry-store setModelsEnabled (BST-1805)', () => {
  beforeEach(() => {
    __resetSettingsTestOverridesForTests();
    useModelRegistryStore.setState({
      models: [model('a', false), model('b', true), model('c', false)],
    });
  });

  it('refuses ids the loaded registry does not hold, without writing', async () => {
    const setModels = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ setModels } as never, ['a', 'zzz'], true)
    ).rejects.toThrow('zzz');
    expect(setModels).not.toHaveBeenCalled();
    expect(enabledStates()).toEqual({ a: false, b: true, c: false });
  });

  it('refuses an empty id list without writing', async () => {
    const setModels = vi.fn();
    await expect(
      useModelRegistryStore.getState().setModelsEnabled({ setModels } as never, [], true)
    ).rejects.toThrow('at least one model');
    expect(setModels).not.toHaveBeenCalled();
  });
});
