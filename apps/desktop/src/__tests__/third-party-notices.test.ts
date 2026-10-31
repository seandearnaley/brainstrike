// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledPackageNotices,
  productionPackageNotices,
  renderThirdPartyNotices,
} from '../../scripts/third-party-notices.mjs';

describe('third-party notices', () => {
  let root: string;
  let appRoot: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'brainstrike-notices-'));
    appRoot = path.join(root, 'apps', 'desktop');
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writePackage(
    dir: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {}
  ): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ version: '1.0.0', ...manifest })
    );
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
  }

  it('names every bundled and packed package once, with its license texts, after the hand-kept notices', () => {
    const modules = path.join(appRoot, 'node_modules');
    const workspacePackage = path.join(root, 'packages', 'tools');
    writePackage(appRoot, {
      dependencies: { '@scope/beta': '1', alpha: '1', tools: 'workspace:*' },
      name: 'app',
      optionalDependencies: { 'other-platform-binding': '1' },
    });
    writePackage(
      path.join(modules, 'alpha'),
      { license: 'MIT', name: 'alpha', peerDependencies: { epsilon: '*', gamma: '*' } },
      { LICENSE: 'Copyright alpha authors' }
    );
    writePackage(path.join(modules, '@scope', 'beta'), {
      license: { type: 'Apache-2.0' },
      name: '@scope/beta',
    });
    writePackage(
      path.join(modules, 'gamma'),
      { license: 'ISC', name: 'gamma' },
      {
        'LICENSE.md': 'Copyright gamma authors',
      }
    );
    // A workspace package is first-party code; the packages it depends on ship.
    writePackage(workspacePackage, { dependencies: { delta: '1' }, name: 'tools' });
    writePackage(
      path.join(workspacePackage, 'node_modules', 'delta'),
      { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }], name: 'delta' },
      { 'LICENSE-APACHE': 'Apache terms, delta authors', 'LICENSE-MIT': 'MIT terms, delta authors' }
    );
    symlinkSync(workspacePackage, path.join(modules, 'tools'), 'junction');
    // Installed further up, but pnpm linked no epsilon for alpha, so none ships.
    writePackage(path.join(root, 'node_modules', 'epsilon'), { license: 'MIT', name: 'epsilon' });
    // Only the renderer bundle inlines this one.
    writePackage(
      path.join(root, 'node_modules', 'react-ish'),
      { license: 'MIT', name: 'react-ish', version: '19.0.0' },
      { 'LICENSE.txt': 'Copyright react-ish authors' }
    );

    const notices = renderThirdPartyNotices({
      appVersion: '1.2.3',
      handKeptNotices: '# Third-Party Notices\n\n## CPython\n',
      packages: [
        ...bundledPackageNotices([
          path.join(root, 'node_modules', 'react-ish', 'index.js'),
          path.join(modules, 'alpha', 'dist', 'index.js'),
          path.join(workspacePackage, 'src', 'index.ts'),
        ]),
        ...productionPackageNotices(appRoot),
      ],
      rendererBundled: true,
    });

    expect(notices.startsWith('# Third-Party Notices\n\n## CPython\n')).toBe(true);
    expect(notices).toContain('Brainstrike 1.2.3 includes the 5 npm packages below');
    const sections = notices.split(`${'-'.repeat(80)}\n`).slice(1);
    expect(sections.map((section) => section.split('\n').slice(0, 2).join(' | '))).toEqual([
      '@scope/beta 1.0.0 | License: Apache-2.0',
      'alpha 1.0.0 | License: MIT',
      'delta 1.0.0 | License: MIT OR Apache-2.0',
      'gamma 1.0.0 | License: ISC',
      'react-ish 19.0.0 | License: MIT',
    ]);
    expect(sections[0]).toContain('The package ships no license text');
    expect(sections[1]).toContain('Copyright alpha authors');
    expect(sections[2]).toContain('Apache terms, delta authors\n\nMIT terms, delta authors');
    expect(sections[3]).toContain('Copyright gamma authors');
    expect(sections[4]).toContain('Copyright react-ish authors');
  });

  it('says when a development build leaves out the renderer bundle', () => {
    const render = (rendererBundled: boolean): string =>
      renderThirdPartyNotices({
        appVersion: '1.2.3',
        handKeptNotices: '',
        packages: [],
        rendererBundled,
      });
    expect(render(true)).not.toContain('no renderer bundle');
    expect(render(false)).toContain('This development build has no renderer bundle');
  });

  it('fails the build when a production dependency is not installed', () => {
    writePackage(appRoot, { dependencies: { absent: '1' }, name: 'app' });
    expect(() => productionPackageNotices(appRoot)).toThrow(
      'app depends on absent, which is not installed.'
    );
  });
});
