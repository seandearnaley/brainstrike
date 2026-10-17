import { addLogListener, configureLogger, LogLevel, type LogRecord } from '@brainstrike/logging';
import { expect, it } from 'vitest';
import { createNativeIndexLifecycle } from '../native-index-lifecycle-owner';
import { readNativeIndexSettings } from '../native-index-settings';

const settings = readNativeIndexSettings(
  '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
);
it('exposes correlated admission, action and terminal spans through the existing logging owner', async () => {
  configureLogger({ console: false, level: LogLevel.INFO });
  const records: LogRecord[] = [];
  const remove = addLogListener((record) => {
    if (record.scope === 'NativeIndexWorkflow') {
      records.push(record);
    }
  });
  try {
    const lifecycle = await createNativeIndexLifecycle(
      { generation: 0, kind: 'idle' },
      {
        execute: async (action) =>
          action.kind === 'open' ? { generation: action.generation, kind: 'opened' } : undefined,
        fence: () => undefined,
      }
    );
    await lifecycle.configure(async () => settings);
    const text = JSON.stringify(records);
    expect(text).toContain('native-index.configure');
    expect(text).toContain('native-index.action');
    expect(text).toContain('"phase":"start"');
    expect(text).toContain('"phase":"end"');
    expect(text).toContain('"outcome":"success"');
    expect(text).not.toContain('worktreeRootIndexingOptInById');
  } finally {
    remove();
  }
});

it('keeps independent cleanup failures observable while redacting all payload and error text', async () => {
  configureLogger({ console: false, level: LogLevel.INFO });
  const records: LogRecord[] = [];
  const remove = addLogListener((record) => {
    if (record.scope === 'NativeIndexWorkflow') {
      records.push(record);
    }
  });
  const settingsFailure = Object.assign(new Error('https://user:password@host/?token=private'), {
    prompt: 'private-prompt',
    token: 'secret-token',
  });
  const cleanup = new TypeError('/private/cleanup/path');
  try {
    const lifecycle = await createNativeIndexLifecycle(
      { generation: 1, kind: 'ready', settings },
      {
        execute: () => {
          throw cleanup;
        },
        fence: () => undefined,
      }
    );
    const rejected = await lifecycle
      .configure(() => Promise.reject(settingsFailure))
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(AggregateError);
    if (!(rejected instanceof AggregateError)) {
      throw new Error('Expected both failures');
    }
    expect(rejected.errors).toEqual([settingsFailure, cleanup]);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain('"failures":2');
    expect(serialized).not.toMatch(/secret-token|private-prompt|password|https|\/private\//u);
    const starts = records.filter(
      (record) => record.message === 'Effect native-index.configure start'
    );
    const ends = records.filter((record) => record.message === 'Effect native-index.configure end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  } finally {
    remove();
  }
});
