// @vitest-environment node

import { resolveNativeCanonicalProfile } from '@brainstrike/canonical-ingestion';
import { describe, expect, it } from 'vitest';
import {
  desktopSetupRequired,
  NativeIndexSetupRequiredError,
} from '../native-index-setup-required';
import { createNativeScopedSearchCapability } from '../native-scoped-search';

const metadata = {
  dimensions: 384,
  distance: 'cosine',
  id: 'collection',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
} as const;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected index operation');
};

describe('native index setup observation', () => {
  it('distinguishes an incomplete profile choice from a malformed profile', () => {
    // Desktop's resolver and memory selection hand the shared profile desktop's refusal.
    expect(() =>
      resolveNativeCanonicalProfile(metadata, undefined, undefined, desktopSetupRequired)
    ).toThrow(NativeIndexSetupRequiredError);
    expect(() => resolveNativeCanonicalProfile({ ...metadata, dimensions: 0 })).not.toThrow(
      NativeIndexSetupRequiredError
    );
  });

  it('reports setup as unavailable repeatedly, while strict reads still reject', async () => {
    const reason = new NativeIndexSetupRequiredError(
      'Choose local model execution in Search & Indexing settings.'
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
