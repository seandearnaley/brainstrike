// The lab is a verification tool Node runs directly, so it ships a bundle:
// workspace packages compiled from source, its third-party dependencies left as
// its own runtime imports. Splitting keeps one instance of each module across
// the public entries a process imports together.
import { fileURLToPath } from 'node:url';
import { ESM_REQUIRE_BANNER, workspaceSourceBundling } from '@brainstrike/config/node-bundle';
import { build } from 'esbuild';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  banner: ESM_REQUIRE_BANNER,
  bundle: true,
  chunkNames: '[name]-[hash]',
  entryPoints: {
    evidence: 'src/evidence.ts',
    faults: 'src/faults.ts',
    index: 'src/index.ts',
    lab: 'src/lab.ts',
    runner: 'src/runner.ts',
    'runner-cli': 'src/runner-cli.ts',
    scenario: 'src/scenario.ts',
  },
  format: 'esm',
  logLevel: 'warning',
  outdir: 'dist',
  platform: 'node',
  plugins: [workspaceSourceBundling],
  splitting: true,
  target: 'node24',
  tsconfigRaw: '{}',
});
