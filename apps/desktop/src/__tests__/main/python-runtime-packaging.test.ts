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
  build: Record<string, { extraResources?: ResourceRule[] }>;
};
const LINUX_TARGET = 'x86_64-unknown-linux-gnu';
const UPSTREAM_ARCHIVE = `cpython-3.13.14+20260728-${LINUX_TARGET}-install_only.tar.gz`;
const LINUX_ARCHIVE = `cpython-3.13.14+20260728-${LINUX_TARGET}-brainstrike-no-dbm-v1.tar.gz`;

interface ResourceRule {
  filter: string[];
  from: string;
  to: string;
}
function pythonRule(platform: string, destination = 'python-runtime'): ResourceRule | undefined {
  return packageJson.build[platform]?.extraResources?.find(
    (rule: ResourceRule) => rule.to === destination
  );
}
function includes(rule: ResourceRule | undefined, filename: string): boolean {
  return rule?.filter.some((pattern) => minimatch(filename, pattern)) ?? false;
}

describe('bundled Python resource packaging', () => {
  it('pins the verified upstream Linux x64 install-only asset', () => {
    expect(manifest.supportedTargets).toContain(LINUX_TARGET);
    expect(manifest.targets[LINUX_TARGET]).toMatchObject({
      bytes: 118_178_436,
      sha256: 'ad6966bfa717f2da83c55eb9e0412bca4039f5501f2c7b42b43079a6052321fd',
    });
    expect(manifest.variant).toBe('install_only');
  });

  it('copies the manifest and Linux archive outside asar while excluding Darwin archives', () => {
    const rule = pythonRule('linux');
    expect(rule?.from).toBe('resources/python-runtime');
    expect(includes(rule, 'manifest.json')).toBe(true);
    expect(includes(rule, LINUX_ARCHIVE)).toBe(true);
    expect(includes(rule, UPSTREAM_ARCHIVE)).toBe(false);
    expect(manifest.targets[LINUX_TARGET]?.derived?.archiveFileName).toBe(LINUX_ARCHIVE);
    expect(
      includes(rule, 'cpython-3.13.14+20260728-aarch64-apple-darwin-install_only.tar.gz')
    ).toBe(false);
    expect(includes(rule, `${LINUX_ARCHIVE}.download-123`)).toBe(false);
  });

  it('ships the complete byte-verified upstream component notice set and source links', () => {
    const licenseDir = path.join(desktopDir, 'licenses/python-linux-x64');
    const hashes = JSON.parse(readFileSync(path.join(licenseDir, 'sha256.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(Object.keys(hashes).sort()).toEqual(
      readdirSync(licenseDir)
        .filter((file) => file.endsWith('.txt'))
        .sort()
    );
    expect(hashes).toHaveProperty('LICENSE.bdb.txt');
    expect(hashes).toHaveProperty('LICENSE.cpython.txt');
    const rule = pythonRule('linux', 'python-runtime/licenses');
    expect(rule?.from).toBe('licenses/python-linux-x64');
    for (const [filename, digest] of Object.entries(hashes)) {
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(licenseDir, filename)))
          .digest('hex')
      ).toBe(digest);
      expect(includes(rule, filename)).toBe(true);
    }
    expect(includes(rule, 'SOURCES.md')).toBe(true);
    expect(readFileSync(path.join(licenseDir, 'SOURCES.md'), 'utf8')).toContain('db-6.0.19.tar.gz');
  });

  it('keeps Linux payloads out of macOS packages and leaves Windows unsupported', () => {
    const rule = pythonRule('mac');
    expect(includes(rule, LINUX_ARCHIVE)).toBe(false);
    expect(
      includes(rule, 'cpython-3.13.14+20260728-aarch64-apple-darwin-install_only.tar.gz')
    ).toBe(true);
    expect(includes(rule, 'cpython-3.13.14+20260728-x86_64-apple-darwin-install_only.tar.gz')).toBe(
      true
    );
    expect(pythonRule('win')).toBeUndefined();
  });
});
