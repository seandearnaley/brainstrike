// @vitest-environment node
/**
 * BST-1648: the two preload bundles run inside sandboxed renderers, where
 * `require` resolves nothing but `electron`. The production build
 * (`scripts/build-main.mjs`) refuses to emit a preload bundle that requires
 * anything else; this suite pins that assertion on synthetic sources and on
 * a real (write:false) esbuild bundle of the real preload entry points, so
 * the guard cannot silently pass against a stale `dist/`.
 */
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
} from '../../scripts/build-main-config.mjs';
import {
  assertPreloadBundleRequires,
  findPreloadBundleRequireViolations,
  PRELOAD_BUNDLE_ENTRY_NAMES,
} from '../../scripts/preload-bundle-contract.mjs';

async function bundlePreloadEntries(): Promise<Record<string, string>> {
  const entryPoints = Object.fromEntries(
    PRELOAD_BUNDLE_ENTRY_NAMES.map((name) => {
      if (!(name in MAIN_PROCESS_ENTRY_POINTS)) {
        throw new Error(`Preload bundle entry ${name} is not a main-process entry point.`);
      }
      return [name, MAIN_PROCESS_ENTRY_POINTS[name as keyof typeof MAIN_PROCESS_ENTRY_POINTS]];
    })
  );
  const result = await esbuild.build({
    ...(MAIN_PROCESS_BUILD_OPTIONS as Omit<esbuild.BuildOptions, 'entryPoints'>),
    entryPoints,
    logLevel: 'silent',
    write: false,
  });
  return Object.fromEntries(
    result.outputFiles.map((file) => [file.path.split('/').pop() ?? file.path, file.text])
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

  it('throws a named error for a bundle that requires beyond electron', () => {
    expect(() =>
      assertPreloadBundleRequires('hidden-preload.js', 'require("electron"); require("node:os");')
    ).toThrow(
      'hidden-preload.js requires modules a sandboxed preload cannot resolve: node:os (only electron is allowed).'
    );
    expect(() =>
      assertPreloadBundleRequires('preload.js', 'var e = require("electron");')
    ).not.toThrow();
  });

  it('bundles the real preload entry points with no require beyond electron', async () => {
    const outputs = await bundlePreloadEntries();
    expect(Object.keys(outputs).sort()).toEqual(['hidden-preload.js', 'preload.js']);
    for (const [fileName, source] of Object.entries(outputs)) {
      expect({ fileName, violations: findPreloadBundleRequireViolations(source) }).toEqual({
        fileName,
        violations: [],
      });
      // Not an empty proof: the one allowed require is really there.
      expect(source).toMatch(/require\("electron"\)/);
    }
  });
});
