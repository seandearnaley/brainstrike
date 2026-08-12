import { describe, expect, it } from 'vitest';
import * as types from '../src/index.js';

describe('@brainstrike/types runtime barrel', () => {
  it('uses real runtime exports without a declaration-emission sentinel', () => {
    expect(types.ConcurrentLoadingError).toBeTypeOf('function');
    expect(types.FileContentError).toBeTypeOf('function');
    expect(types.PartialRefreshError).toBeTypeOf('function');
    expect(types).not.toHaveProperty('TYPES_DUMMY_EXPORT');
  });
});
