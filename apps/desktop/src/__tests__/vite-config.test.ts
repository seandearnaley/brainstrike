import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { describe, expect, it } from 'vitest';

function readDesktopViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

const PACKAGES_DIR = path.resolve(process.cwd(), '../../packages');

/**
 * Registry entries. Deliberately NOT loading the real vite.config.mts here
 * (e.g. via Vite's `loadConfigFromFile`): that file's own top-level imports
 * (`@brainstrike/build-utils`, `@brainstrike/utils`) require those packages'
 * built `dist` to even load, which would make this test — unlike every other
 * test in this suite since B4 dropped `test.dependsOn: ["^build"]` — silently
 * require a prior build. Testing the shared registry function directly
 * verifies the exact same resolution behavior these configs spread
 * (`...workspaceSrcAliases(...)`) without that dependency; the text
 * assertions below separately confirm each config actually spreads it and
 * does not shadow these specifiers with a stale local override.
 */
const registryEntries = workspaceSrcAliases(PACKAGES_DIR);

describe('desktop vite config alias contract', () => {
  it('keeps the documented production chunk warning ceiling', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('chunkSizeWarningLimit: 1300');
  });

  it('filters only CSP-qualified dependency eval warnings', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('createCspQualifiedEvalWarningFilter,');
    expect(config).toContain('onLog: createCspQualifiedEvalWarningFilter()');
  });

  it('spreads the shared workspace-src-alias registry', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('workspaceSrcAliases(');
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    // Deliberate LOCAL override: file-tree-worker's package.json root export
    // targets a Node-worker_threads dist entry, so the registry would derive
    // that same Node-targeted src/index.ts — this app needs the
    // browser-adapted vite.ts implementation instead. Text-checked (not
    // execution-checked) since it is not registry-derived.
    const config = readDesktopViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]{0,120}replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
  });

  it('aliases @brainstrike/workers subpaths explicitly (no src/ dir, registry skips it)', () => {
    const config = readDesktopViteConfig();

    expect(config).toMatch(/find:\s*'@brainstrike\/workers'/);
    expect(resolveThroughAliases('@brainstrike/workers', registryEntries)).toBeNull();
  });

  it('uses a dedicated strict dev-server port for the desktop renderer', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain(
      "import { DESKTOP_DEV_RENDERER_PORT } from './src/desktop-renderer-url';"
    );
    expect(config).toContain('port: DESKTOP_DEV_RENDERER_PORT');
    expect(config).toContain('strictPort: true');
  });

  it('warms the desktop renderer entry during dev-server startup', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('warmup: {');
    expect(config).toContain("clientFiles: ['./src/renderer/main.tsx']");
  });
});
