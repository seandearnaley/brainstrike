import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

test('provider and exact provider/model choices survive reopen and bulk writes are atomic', async () => {
  const root = freshDir('model-choices');
  let store = await StateStore.open(root);
  try {
    await store.modelChoices({ enabled: true, operation: 'provider', providerId: 'openai' });
    await store.modelChoices({
      models: [
        { enabled: false, modelId: 'gpt-4o', providerId: 'openai' },
        { enabled: true, modelId: 'Xenova/bge-small-en-v1.5', providerId: 'local' },
      ],
      operation: 'models',
    });
    const before = await store.modelChoices({ operation: 'snapshot' });
    await expect(
      store.modelChoices({
        models: [
          { enabled: true, modelId: 'gpt-4o', providerId: 'openai' },
          { enabled: true, modelId: '', providerId: 'local' },
        ],
        operation: 'models',
      })
    ).rejects.toThrow();
    expect(await store.modelChoices({ operation: 'snapshot' })).toEqual(before);
    await store.close();
    store = await StateStore.open(root);
    expect(await store.modelChoices({ operation: 'snapshot' })).toEqual(before);
    expect(before.models).toContainEqual({
      enabled: false,
      modelId: 'gpt-4o',
      providerId: 'openai',
    });
    expect(before.providers).toEqual([{ enabled: true, providerId: 'openai' }]);
  } finally {
    await store.close();
  }
});

test('provider defaults cannot re-enable an explicit user choice and seed remains provider-wide', async () => {
  const store = await StateStore.open(freshDir('model-default-choices'));
  try {
    await store.modelChoices({
      models: [{ enabled: false, modelId: 'gpt-4o', providerId: 'openai' }],
      operation: 'models',
    });
    const initialized = await store.modelChoices({
      modelIds: ['gpt-4o', 'gpt-4o-mini'],
      operation: 'initialize',
      policy: 'all',
      providerId: 'openai',
    });
    expect(initialized.models).toEqual([
      { enabled: false, modelId: 'gpt-4o', providerId: 'openai' },
      { enabled: true, modelId: 'gpt-4o-mini', providerId: 'openai' },
    ]);
    const preserved = await store.modelChoices({
      modelIds: ['gpt-4o'],
      operation: 'initialize',
      policy: 'seed',
      providerId: 'openai',
    });
    expect(preserved.models).toEqual(initialized.models);
    expect(preserved.providers).toEqual(initialized.providers);
    expect(preserved.outcome).toBe('preserved');
    expect(initialized.outcome).toBe('initialized');
    await expect(
      store.modelChoices({
        modelIds: [],
        operation: 'initialize',
        policy: 'seed',
        providerId: 'openai',
      })
    ).rejects.toThrow();
  } finally {
    await store.close();
  }
});

test('each overlapping model mutation returns the exact prior writer snapshot for Undo', async () => {
  const store = await StateStore.open(freshDir('model-choice-undo'));
  const model = { modelId: 'gpt-4o', providerId: 'openai' };
  try {
    await store.modelChoices({ models: [{ ...model, enabled: false }], operation: 'models' });
    const [enabled, disabled] = await Promise.all([
      store.modelChoices({ models: [{ ...model, enabled: true }], operation: 'models' }),
      store.modelChoices({ models: [{ ...model, enabled: false }], operation: 'models' }),
    ]);
    expect(enabled.previous?.models).toEqual([{ ...model, enabled: false }]);
    expect(disabled.previous?.models).toEqual([{ ...model, enabled: true }]);
    expect((await store.modelChoices({ operation: 'snapshot' })).models).toEqual([
      { ...model, enabled: false },
    ]);
  } finally {
    await store.close();
  }
});
