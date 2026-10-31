// @vitest-environment node
/**
 * BST-1648: the preload bundle runs inside a sandboxed renderer, where
 * `require` resolves nothing but `electron`. The production build
 * (`scripts/build-main.mjs`) refuses to emit a preload bundle that requires
 * anything else; this suite pins that assertion on synthetic sources and on
 * a real (write:false) esbuild bundle of the real preload entry point, so
 * the guard cannot silently pass against a stale `dist/`.
 */
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { PRELOAD_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import {
  assertPreloadBundleRequires,
  findPreloadBundleRequireViolations,
} from '../../scripts/preload-bundle-contract.mjs';

async function bundlePreloadEntries(): Promise<Record<string, string>> {
  const result = await esbuild.build({
    ...(PRELOAD_BUILD_OPTIONS as esbuild.BuildOptions),
    logLevel: 'silent',
    write: false,
  });
  return Object.fromEntries(
    result.outputFiles.map((file) => [path.basename(file.path), file.text])
  );
}

describe('preload bundle contract', () => {
  it('lists only external requires other than electron', () => {
    const source = [
      'var electron = require("electron");',
      "var fs = require('node:fs');",
      'var pkg = __toESM(require("@brainstrike/logging"));',
      'const later = require(  "child_process" );',
    ].join('\n');
    expect(findPreloadBundleRequireViolations(source)).toEqual([
      '@brainstrike/logging',
      'child_process',
      'node:fs',
    ]);
  });

  it('lists a require or import whose specifier is computed', () => {
    const source = [
      'var electron = require("electron");',
      'var mod = require(name);',
      'const later = import( specifier );',
    ].join('\n');
    expect(findPreloadBundleRequireViolations(source)).toEqual([
      'import(<computed>)',
      'require(<computed>)',
    ]);
  });

  it('throws a named error for a bundle that requires beyond electron', () => {
    expect(() =>
      assertPreloadBundleRequires('preload.js', 'require("electron"); require("node:os");')
    ).toThrow(
      'preload.js requires modules a sandboxed preload cannot resolve: node:os (only electron is allowed).'
    );
    expect(() =>
      assertPreloadBundleRequires('preload.js', 'var e = require("electron");')
    ).not.toThrow();
  });

  it('bundles the real preload entry point with no require beyond electron', async () => {
    const outputs = await bundlePreloadEntries();
    expect(Object.keys(outputs)).toEqual(['preload.cjs']);
    for (const [fileName, source] of Object.entries(outputs)) {
      expect({ fileName, violations: findPreloadBundleRequireViolations(source) }).toEqual({
        fileName,
        violations: [],
      });
      // Not an empty proof: the one allowed require is really there.
      expect(source).toMatch(/require\("electron"\)/u);
    }
  });
});
