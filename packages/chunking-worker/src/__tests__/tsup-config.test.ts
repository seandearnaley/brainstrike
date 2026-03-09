import { describe, expect, it } from 'vitest';
import config from '../../tsup.config';

describe('chunking worker tsup config', () => {
  it('bundles langchain core into the worker output', () => {
    const noExternal = Array.isArray(config.noExternal) ? config.noExternal : [];
    expect(noExternal).toContain('@langchain/core');
    expect(noExternal).toContain('@langchain/textsplitters');
    expect(noExternal).toContain('tiktoken');
  });
});
