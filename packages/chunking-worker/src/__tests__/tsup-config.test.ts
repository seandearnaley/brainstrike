import { describe, expect, it } from 'vitest';
import config from '../../tsup.config';

describe('chunking worker tsup config', () => {
  it('bundles the native text splitter into the worker output', () => {
    const noExternal = Array.isArray(config.noExternal) ? config.noExternal : [];
    expect(noExternal).toContain('@brainstrike/text-splitter');
    expect(noExternal).toContain('tiktoken');
  });
});
