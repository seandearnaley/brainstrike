import { fileURLToPath } from 'node:url';
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
    expect(noExternal).toContain('tiktoken');
  });

  it('allows the worker bundle to split lazy-loaded heavy dependencies', () => {
    const resolvedConfig = resolveConfig();
    const targetConfig = Array.isArray(resolvedConfig) ? resolvedConfig[0] : resolvedConfig;
    expect(targetConfig.splitting).toBe(true);
  });

  it('bundles the shared accurate token runtime from source', () => {
    const resolvedConfig = resolveConfig();
    const targetConfig = Array.isArray(resolvedConfig) ? resolvedConfig[0] : resolvedConfig;
    const buildOptions: { alias?: Record<string, string> } = {};

    targetConfig.esbuildOptions?.(buildOptions, { format: 'esm' });

    expect(buildOptions.alias?.['@brainstrike/utils/token-utils-accurate-lite']).toBe(
      fileURLToPath(new URL('../../../utils/src/token-utils-accurate-lite.ts', import.meta.url))
    );
  });
});
