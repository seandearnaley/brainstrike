// @vitest-environment node
/**
 * Entries one process loads (Main's bootstrap and runtime; the agent host's
 * launcher and platform) must share one instance of every module, or a logger
 * configured in one is not the logger another uses, and an error one creates
 * fails `instanceof` in another. The Node build is one code-split ESM build for
 * exactly that reason.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NODE_PROCESS_BUILD_OPTIONS,
  NODE_PROCESS_ENTRY_POINTS,
} from '../../scripts/build-main-config.mjs';

const nodeProcessBuild = NODE_PROCESS_BUILD_OPTIONS as esbuild.BuildOptions;
const desktopRoot = path.resolve(import.meta.dirname, '../..');
// Inside the app, so the bundle's third-party imports resolve from its node_modules.
const cacheRoot = path.join(desktopRoot, 'node_modules', '.cache', 'node-process-bundle-test');
mkdirSync(cacheRoot, { recursive: true });
const outdir = mkdtempSync(path.join(cacheRoot, 'bundle-'));

afterAll(() => {
  rmSync(outdir, { force: true, recursive: true });
});

describe('Node process bundle', () => {
  it('emits every module once across the entries, so a process holds one instance of each', async () => {
    const result = await esbuild.build({
      ...nodeProcessBuild,
      logLevel: 'silent',
      metafile: true,
      write: false,
    });
    const outputsByInput = new Map<string, string[]>();
    for (const [output, { inputs }] of Object.entries(result.metafile.outputs)) {
      for (const input of Object.keys(inputs)) {
        outputsByInput.set(input, [...(outputsByInput.get(input) ?? []), output]);
      }
    }
    const duplicated = [...outputsByInput].filter(([, outputs]) => outputs.length > 1);
    const outputs = Object.values(result.metafile.outputs);

    // Not vacuous: every entry was bundled, and the entries share split chunks.
    expect(outputs.map((output) => output.entryPoint)).toEqual(
      expect.arrayContaining(
        Object.values(NODE_PROCESS_ENTRY_POINTS).map((entry) =>
          path.relative(desktopRoot, path.resolve(desktopRoot, entry))
        )
      )
    );
    expect(outputs.some((output) => output.entryPoint === undefined)).toBe(true);
    expect(duplicated).toEqual([]);
  });

  it('shares the logger and error classes between two entries loaded in one process', async () => {
    await esbuild.build({
      ...nodeProcessBuild,
      entryPoints: {
        'configure-entry': path.join(
          import.meta.dirname,
          'fixtures/split-bundle/configure-entry.ts'
        ),
        'report-entry': path.join(import.meta.dirname, 'fixtures/split-bundle/report-entry.ts'),
      },
      logLevel: 'silent',
      outdir,
    });

    await import(pathToFileURL(path.join(outdir, 'configure-entry.js')).href);
    await import(pathToFileURL(path.join(outdir, 'report-entry.js')).href);
    const proof = (
      globalThis as unknown as {
        splitBundleProof: {
          configuredErrorClass: abstract new (...args: never[]) => unknown;
          messages: string[];
          reportedError: unknown;
        };
      }
    ).splitBundleProof;

    expect(proof.messages).toContain('reported by the second entry');
    expect(proof.reportedError).toBeInstanceOf(proof.configuredErrorClass);
  });
});
