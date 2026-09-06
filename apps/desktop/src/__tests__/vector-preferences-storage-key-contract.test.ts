import { VECTOR_PREFERENCES_STORE_NAME } from '@brainstrike/app-state/stores/vector-preferences-store-name';
import { describe, expect, it } from 'vitest';
import { VECTOR_PREFERENCES_STORAGE_KEY } from '../platform/vector-preferences-storage-key';

/**
 * BST-1380: main pins the canonical vector-preferences key so the scoped
 * capability never accepts a renderer-supplied key. Main deliberately does not
 * import the renderer store at runtime, so this test is what keeps the two
 * literals from drifting — a drift would silently point hidden hosts at a
 * record the visible UI never writes, which is exactly the regression the
 * scoped capability exists to prevent.
 */
describe('vector preferences storage key contract', () => {
  it('pins the same record the app-state store persists', () => {
    expect(VECTOR_PREFERENCES_STORAGE_KEY).toBe(VECTOR_PREFERENCES_STORE_NAME);
  });
});
