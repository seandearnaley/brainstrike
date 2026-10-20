import { describe, expect, it } from 'vitest';
import {
  browserBareDynamicImportGuardPlugin,
  findBareDynamicImports,
} from '../browser-bare-dynamic-import.js';

describe('findBareDynamicImports (BST-2230)', () => {
  it('finds a bare specifier, as a @vite-ignore import leaves it in minified output', () => {
    expect(
      findBareDynamicImports(
        'async function H(){return x||(x=import(`@huggingface/transformers`)),await x}' +
          'const y=()=>import("@scope/pkg/sub");const z=()=>import(\'lodash\')'
      )
    ).toEqual(['@huggingface/transformers', '@scope/pkg/sub', 'lodash']);
  });

  it('ignores chunk-relative, absolute, URL and computed imports', () => {
    expect(
      findBareDynamicImports(
        'import("./chunk-a.js");import("../b.js");import("/assets/c.js");' +
          // A computed template specifier, as emitted: `${base}/e.js`.
          'import("brainstrike-app://bundle/d.js");import(`$' +
          '{base}/e.js`);import(name)'
      )
    ).toEqual([]);
  });
});

describe('browserBareDynamicImportGuardPlugin', () => {
  const generate = (bundle: Record<string, { code?: string; fileName: string; type: string }>) => {
    const plugin = browserBareDynamicImportGuardPlugin();
    const errors: string[] = [];
    const context = {
      error(message: string): never {
        errors.push(message);
        throw new Error(message);
      },
    };
    try {
      plugin.generateBundle.call(context, {}, bundle);
    } catch {
      // The guard fails the build through `this.error`.
    }
    return errors;
  };

  it('fails the build naming each chunk that keeps a bare dynamic import', () => {
    const errors = generate({
      'assets/index.css': { fileName: 'assets/index.css', type: 'asset' },
      'assets/ok.js': { code: 'import("./x.js")', fileName: 'assets/ok.js', type: 'chunk' },
      'assets/transformers-backend.js': {
        code: 'import("@huggingface/transformers")',
        fileName: 'assets/transformers-backend.js',
        type: 'chunk',
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'assets/transformers-backend.js: import("@huggingface/transformers")'
    );
    expect(errors[0]).not.toContain('assets/ok.js');
  });

  it('passes a bundle whose dynamic imports are all chunks', () => {
    expect(
      generate({
        'assets/a.js': { code: 'import("./b.js")', fileName: 'assets/a.js', type: 'chunk' },
      })
    ).toEqual([]);
  });
});
