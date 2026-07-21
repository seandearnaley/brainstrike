import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';

describe('provider-native programmatic tool-calling compatibility seam', () => {
  it('pins the installed adapter gap evaluated by BST-616', () => {
    const tools = createOpenAI({ apiKey: 'not-used' }).tools;

    // When the SDK adds this surface, fail visibly so the no-go decision and
    // provider-native evaluation can be revisited instead of drifting stale.
    expect(tools).not.toHaveProperty('programmaticToolCalling');
  });
});
