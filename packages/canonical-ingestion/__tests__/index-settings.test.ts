// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readNativeIndexSettings, readNativeSavedPause } from '../src/index-settings.js';

// The seam a host fills: its own refusal for a missing search choice. Desktop's
// decoding is covered by its native-index-settings suites.
class HostSetupRequired extends Error {}
const hostRefusal = (message: string) => new HostSetupRequired(message);
const stored = (state: Record<string, unknown>) =>
  JSON.stringify({
    state: {
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      nativeIndexMode: 'TEXT',
      paused: false,
      ...state,
    },
    version: 6,
  });

describe('index settings host seam', () => {
  it.each([
    ['no saved value', null, 'Choose a search mode'],
    ['no saved mode', stored({ nativeIndexMode: null }), 'Choose a search mode'],
    [
      'VECTOR with no collection',
      stored({ nativeIndexMode: 'VECTOR' }),
      'Choose an embedding model and collection',
    ],
  ])('refuses %s with the host refusal when given one', (_case, value, message) => {
    expect(() => readNativeIndexSettings(value)).toThrow(message);
    expect(() => readNativeIndexSettings(value)).not.toThrow(HostSetupRequired);
    expect(() => readNativeIndexSettings(value, hostRefusal)).toThrow(HostSetupRequired);
  });

  it('passes the host refusal through a saved pause', () => {
    const paused = stored({ nativeIndexMode: null, paused: true });
    expect(() => readNativeSavedPause(paused, hostRefusal)).toThrow(HostSetupRequired);
    expect(readNativeSavedPause(stored({}), hostRefusal)).toBeNull();
  });

  it('reads a complete saved choice', () => {
    expect(readNativeIndexSettings(stored({ managedCollectionId: 'set' }))).toMatchObject({
      enabled: true,
      managedCollectionId: 'set',
      mode: 'TEXT',
      paused: false,
    });
  });
});
