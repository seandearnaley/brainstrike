import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

const TOKENIZER_ASSET_IMPORT = /^tiktoken\/encoders\/o200k_base\.json\?url$/;
const TOKENIZER_ASSET_NAMESPACE = 'brainstrike-tokenizer-asset';

export const tokenizerAssetPlugin: Plugin = {
  name: TOKENIZER_ASSET_NAMESPACE,
  setup(build) {
    build.onResolve({ filter: TOKENIZER_ASSET_IMPORT }, async (args) => {
      const result = await build.resolve('tiktoken/encoders/o200k_base.json', {
        importer: args.importer,
        kind: args.kind,
        resolveDir: args.resolveDir,
      });

      if (result.errors.length > 0) {
        return { errors: result.errors };
      }
      if (!result.path) {
        return {
          errors: [{ text: 'Could not resolve the o200k_base tokenizer asset' }],
        };
      }

      return {
        namespace: TOKENIZER_ASSET_NAMESPACE,
        path: result.path,
      };
    });

    build.onLoad({ filter: /.*/, namespace: TOKENIZER_ASSET_NAMESPACE }, async (args) => ({
      contents: await readFile(args.path),
      loader: 'file',
      watchFiles: [args.path],
    }));
  },
};
