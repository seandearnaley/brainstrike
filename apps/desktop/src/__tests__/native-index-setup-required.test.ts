// @vitest-environment node

import { NativeIndexSetupRequiredError } from '@brainstrike/assistant-service/node-native-text-services';
import { describe, expect, it } from 'vitest';
import { createNativeScopedSearchCapability } from '../native-scoped-search';

const unused = async (): Promise<never> => {
  throw new Error('Unexpected index operation');
};

describe('native index setup observation', () => {
  it('reports setup as unavailable repeatedly, while strict reads still reject', async () => {
    const reason = new NativeIndexSetupRequiredError(
      'Choose a search model in Search & Indexing settings.'
    );
    const capability = createNativeScopedSearchCapability({
      openQuery: unused,
      rebuild: unused,
      withRead: async () => {
        throw reason;
      },
    });
    for (let poll = 0; poll < 3; poll += 1) {
      await expect(capability.status()).resolves.toEqual({
        cause: { kind: 'setup-required', message: reason.message },
        kind: 'unavailable',
        phase: 'setup-required',
        reason: reason.message,
      });
    }
    await expect(capability.coverage({ rootIds: [] })).rejects.toBe(reason);
  });

  it('preserves a retained setup reason, but never suppresses independent cleanup failures', async () => {
    const setup = new NativeIndexSetupRequiredError('Choose a collection.');
    expect(setup.refusal).toEqual({ kind: 'setup-required', message: setup.message });
    const failures = [
      new Error(setup.message),
      new AggregateError([setup, new Error('Cleanup failed')], 'Retirement failed'),
    ];
    for (const failure of failures) {
      const capability = createNativeScopedSearchCapability({
        openQuery: unused,
        rebuild: unused,
        withRead: async () => {
          throw failure;
        },
      });
      await expect(capability.status()).rejects.toBe(failure);
    }
  });
});
