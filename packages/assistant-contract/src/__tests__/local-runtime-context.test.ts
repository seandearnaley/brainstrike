import { describe, expect, it } from 'vitest';
import { DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW } from '../context-budget.js';
import { localRuntimeContextWindow } from '../local-runtime-context.js';

describe('localRuntimeContextWindow (BST-754)', () => {
  it('uses a smaller reported context, caps a larger one, and defaults an unreported one', () => {
    expect(localRuntimeContextWindow(16_384)).toEqual({ source: 'reported', tokens: 16_384 });
    expect(localRuntimeContextWindow(262_144)).toEqual({
      source: 'capped',
      tokens: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
    });
    expect(localRuntimeContextWindow(undefined)).toEqual({
      source: 'default',
      tokens: DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW,
    });
  });
});
