import { describe, expect, it } from 'vitest';
import config from '../../tsup.config';

function resolveConfig() {
  return typeof config === 'function' ? config({}) : config;
}

describe('chunking worker tsup config', () => {
  it('bundles the native text splitter into the worker output', () => {
    const resolvedConfig = resolveConfig();
    const targetConfig = Array.isArray(resolvedConfig) ? resolvedConfig[0] : resolvedConfig;
    const noExternal = Array.isArray(targetConfig.noExternal) ? targetConfig.noExternal : [];
    expect(noExternal).toContain('@brainstrike/text-splitter');
    expect(noExternal).toContain('@brainstrike/tokenization');
  });

  it('allows the worker bundle to split lazy-loaded heavy dependencies', () => {
    const resolvedConfig = resolveConfig();
    const targetConfig = Array.isArray(resolvedConfig) ? resolvedConfig[0] : resolvedConfig;
    expect(targetConfig.splitting).toBe(true);
  });

  it('does not maintain a source alias for the shared tokenization owner', () => {
    const resolvedConfig = resolveConfig();
    const targetConfig = Array.isArray(resolvedConfig) ? resolvedConfig[0] : resolvedConfig;
    const buildOptions: { alias?: Record<string, string> } = {};

    targetConfig.esbuildOptions?.(buildOptions, { format: 'esm' });

    expect(buildOptions.alias).toBeUndefined();
  });
});
