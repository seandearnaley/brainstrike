import { spawnSync } from 'node:child_process';
import path from 'node:path';

const directory = { arm64: 'linux-arm64-unpacked', x64: 'linux-unpacked' }[process.arch];
if (process.platform !== 'linux' || !directory) {
  throw new Error(`Unsupported packaged Python probe target: ${process.platform}/${process.arch}.`);
}
const desktopDir = path.resolve(import.meta.dirname, '..');
const env = { ...process.env };
env.ELECTRON_RUN_AS_NODE = '1';
const result = spawnSync(
  path.join(desktopDir, 'release', directory, 'brainstrike-desktop'),
  [
    path.join(desktopDir, 'src/__tests__/fixtures/packaged-python-fence-probe.cjs'),
    ...process.argv.slice(2),
  ],
  { env, stdio: 'inherit', timeout: 120_000 }
);
if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`Packaged Python probe terminated by ${result.signal}.`);
}
process.exitCode = result.status;
