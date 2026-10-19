import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import type { PythonRuntimeManifest } from '../../python-runtime/resolve-python-binary';

const desktopDir = path.resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(
  readFileSync(path.join(desktopDir, 'resources/python-runtime/manifest.json'), 'utf8')
) as PythonRuntimeManifest;
const packageJson = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')) as {
  build: Record<string, { asarUnpack?: string[]; extraResources?: ResourceRule[] }> & {
    beforePack?: string;
  };
  scripts: Record<string, string>;
};
const LINUX_TARGET = 'x86_64-unknown-linux-gnu';
const UPSTREAM_ARCHIVE = `cpython-3.13.14+20260728-${LINUX_TARGET}-install_only.tar.gz`;
const LINUX_ARCHIVE = `cpython-3.13.14+20260728-${LINUX_TARGET}-brainstrike-no-dbm-v1.tar.gz`;

interface ResourceRule {
  filter?: string[];
  from: string;
  to: string;
}
function pythonRules(platform: string, destination = 'python-runtime'): ResourceRule[] {
  return (packageJson.build[platform]?.extraResources ?? []).filter(
    (rule: ResourceRule) => rule.to === destination
  );
}
function pythonRule(platform: string, destination = 'python-runtime'): ResourceRule | undefined {
  return pythonRules(platform, destination)[0];
}
function includes(rule: ResourceRule | undefined, filename: string): boolean {
  return rule?.filter?.some((pattern) => minimatch(filename, pattern)) ?? false;
}

describe('bundled Python resource packaging', () => {
  it('prepares packaging resources for the builder target and starts with host-only preparation', () => {
    expect(packageJson.build.beforePack).toBe('./scripts/prepare-python-runtime-before-pack.mjs');
    expect(packageJson.scripts['pack']).toBe('pnpm build:cached && electron-builder --dir');
    expect(packageJson.scripts['dist']).toBe('pnpm build && electron-builder');
    expect(packageJson.scripts['start']).toBe(
      'node scripts/fetch-python-runtime.mjs --platform=host && pnpm build && electron . --no-sandbox --brainstrike-desktop-launch-mode=built'
    );
    expect(packageJson.scripts['fetch:python-runtime']).toBe(
      'node scripts/fetch-python-runtime.mjs --all'
    );
  });

  it('explicitly unpacks the matching Linux seccomp helper without changing macOS rules', () => {
    const rule =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands this literal architecture macro.
      '**/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/${arch}/apply-seccomp';
    expect(packageJson.build['linux']?.asarUnpack).toContain(rule);
    expect(packageJson.build['mac']?.asarUnpack).toBeUndefined();
  });

  it('pins the verified upstream Linux x64 install-only asset', () => {
    expect(manifest.supportedTargets).toContain(LINUX_TARGET);
    expect(manifest.targets[LINUX_TARGET]).toMatchObject({
      bytes: 118_178_436,
      sha256: 'ad6966bfa717f2da83c55eb9e0412bca4039f5501f2c7b42b43079a6052321fd',
    });
    expect(manifest.variant).toBe('install_only');
  });

  it('copies the manifest and the Linux build-time unpack outside asar, and never an archive', () => {
    const [manifestRule, treeRule] = pythonRules('linux');
    expect(pythonRules('linux')).toHaveLength(2);
    expect(manifestRule?.from).toBe('resources/python-runtime');
    expect(manifestRule?.filter).toEqual(['manifest.json']);
    for (const archive of [
      LINUX_ARCHIVE,
      UPSTREAM_ARCHIVE,
      'cpython-3.13.14+20260728-aarch64-apple-darwin-install_only.tar.gz',
    ]) {
      expect(includes(manifestRule, archive), archive).toBe(false);
    }
    // BST-1627: the derived archive is unpacked at build time; its tree ships loose.
    expect(treeRule).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands this literal architecture macro.
      from: 'resources/python-runtime/unpacked/linux-${arch}',
      to: 'python-runtime',
    });
    expect(manifest.targets[LINUX_TARGET]?.derived?.archiveFileName).toBe(LINUX_ARCHIVE);
  });

  it.each(['x64', 'arm64'])(
    'ships the complete byte-verified %s component notice set and source links',
    (arch) => {
      const licenseDir = path.join(desktopDir, `licenses/python-linux-${arch}`);
      const hashes = JSON.parse(
        readFileSync(path.join(licenseDir, 'sha256.json'), 'utf8')
      ) as Record<string, string>;
      expect(Object.keys(hashes).sort()).toEqual(
        readdirSync(licenseDir)
          .filter((file) => file.endsWith('.txt'))
          .sort()
      );
      expect(hashes).toHaveProperty('LICENSE.bdb.txt');
      expect(hashes).toHaveProperty('LICENSE.cpython.txt');
      const rule = pythonRule('linux', 'python-runtime/licenses');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands this literal architecture macro.
      expect(rule?.from).toBe('licenses/python-linux-${arch}');
      for (const [filename, digest] of Object.entries(hashes)) {
        expect(
          createHash('sha256')
            .update(readFileSync(path.join(licenseDir, filename)))
            .digest('hex')
        ).toBe(digest);
        expect(includes(rule, filename)).toBe(true);
      }
      expect(includes(rule, 'SOURCES.md')).toBe(true);
      expect(readFileSync(path.join(licenseDir, 'SOURCES.md'), 'utf8')).toContain(
        'db-6.0.19.tar.gz'
      );
    }
  );

  it('keeps Linux payloads and every archive out of macOS packages, and leaves Windows unsupported', () => {
    const [manifestRule, treeRule] = pythonRules('mac');
    expect(pythonRules('mac')).toHaveLength(2);
    expect(manifestRule?.filter).toEqual(['manifest.json']);
    expect(includes(manifestRule, LINUX_ARCHIVE)).toBe(false);
    expect(
      includes(manifestRule, 'cpython-3.13.14+20260728-aarch64-apple-darwin-install_only.tar.gz')
    ).toBe(false);
    expect(treeRule).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands this literal architecture macro.
      from: 'resources/python-runtime/unpacked/darwin-${arch}',
      to: 'python-runtime',
    });
    expect(pythonRule('win')).toBeUndefined();
  });
});
