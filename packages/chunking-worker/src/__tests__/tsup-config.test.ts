import { describe, expect, it } from 'vitest';
import config from '../../tsup.config';

async function resolveConfig() {
  const resolved = await (typeof config === 'function' ? config({}) : config);
  const target = Array.isArray(resolved) ? resolved[0] : resolved;
  if (!target) {
    throw new Error('Expected the chunking worker build configuration');
  }
  return target;
}

describe('chunking worker tsup config', () => {
  it('bundles the native text splitter into the worker output', async () => {
    const targetConfig = await resolveConfig();
    const noExternal = Array.isArray(targetConfig.noExternal) ? targetConfig.noExternal : [];
    expect(noExternal).toContain('@brainstrike/text-splitter');
    expect(noExternal).toContain('@brainstrike/tokenization');
  });

  it('allows the worker bundle to split lazy-loaded heavy dependencies', async () => {
    const targetConfig = await resolveConfig();
    expect(targetConfig.splitting).toBe(true);
  });

  it('does not maintain a source alias for the shared tokenization owner', async () => {
    const targetConfig = await resolveConfig();
    const buildOptions: { alias?: Record<string, string> } = {};

    targetConfig.esbuildOptions?.(buildOptions, { format: 'esm' });

    expect(buildOptions.alias).toBeUndefined();
  });
});
