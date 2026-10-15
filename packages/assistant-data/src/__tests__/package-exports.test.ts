// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/assistant-data package contract', () => {
  it('publishes the required export subpaths', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './assistant-memory-repository',
        './assistant-memory-resource',
        './assistant-thread-metadata-merge',
        './assistant-thread-run-reaper',
        './cost-tracking',
      ].sort()
    );
  });

  it('has source entry points for every code export', () => {
    expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/assistant-thread-run-reaper.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/assistant-memory-repository.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/cost-tracking/index.ts'))).toBe(true);
  });

  it('resolves the public assistant memory resource entry point', () => {
    const entryPoint = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "process.stdout.write(import.meta.resolve('@brainstrike/assistant-data/assistant-memory-resource'));",
      ],
      { cwd: packageRoot, encoding: 'utf8' }
    );

    expect(entryPoint).toBe(
      pathToFileURL(join(packageRoot, 'dist/assistant-memory-resource.js')).href
    );
  });
});
