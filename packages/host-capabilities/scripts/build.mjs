// The `brainstrike` CLI is a Node executable, so this package ships it as a
// bundle: the Core CLI, this package's platform, the host process entry the CLI
// forks, and the Windows command wrapper, with every workspace package compiled
// from source. The library itself is consumed as source (`exports`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHostNodeBundles } from '@brainstrike/config/node-bundle';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesRoot = path.resolve(packageRoot, '..');

for (const options of agentHostNodeBundles({
  absWorkingDir: packageRoot,
  entryPoints: {
    cli: path.join(packagesRoot, 'agent-host/src/cli.ts'),
    'host-process-entry': path.join(packagesRoot, 'agent-host/src/host-process-entry.ts'),
    platform: 'src/platform.ts',
    'windows-command-wrapper': 'src/windows-command-wrapper.ts',
  },
  outdir: 'dist',
  packagesRoot,
})) {
  await build(options);
}
