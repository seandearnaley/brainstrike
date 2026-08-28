import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NATIVE_PACKAGE_PREFIXES = ['packages/secure-fs-native/', 'packages/windows-job-native/'];
const INSTALL_CONTRACT_PATHS = new Set([
  '.npmrc',
  '.nvmrc',
  '.pnpmfile.cjs',
  'apps/desktop/scripts/chmod-pty-spawn-helper.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/native-windows-impact.mjs',
  'scripts/postinstall.js',
]);
const CI_CONTRACT_PREFIXES = ['.github/actions/setup-workspace/', 'patches/'];

export function requiresNativeWindows(paths) {
  for (const changedPath of paths) {
    if (typeof changedPath !== 'string' || changedPath.length === 0) {
      throw new TypeError('Changed paths must be non-empty strings.');
    }
    if (changedPath.startsWith('/') || changedPath.split('/').includes('..')) {
      throw new TypeError(`Changed path must be repository-relative: ${changedPath}`);
    }
    if (INSTALL_CONTRACT_PATHS.has(changedPath) || changedPath.endsWith('/package.json')) {
      return true;
    }
    if (changedPath === '.github/workflows/test.yml') {
      return true;
    }
    if (CI_CONTRACT_PREFIXES.some((prefix) => changedPath.startsWith(prefix))) {
      return true;
    }
    if (NATIVE_PACKAGE_PREFIXES.some((prefix) => changedPath.startsWith(prefix))) {
      return true;
    }
  }

  return false;
}

function readChangedPathsFromStdin() {
  const input = readFileSync(0);
  if (input.length === 0) {
    return [];
  }
  if (input.at(-1) !== 0) {
    throw new Error('Changed-path input must be NUL-terminated git diff output.');
  }

  return input.toString('utf8').split('\0').slice(0, -1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(`${requiresNativeWindows(readChangedPathsFromStdin())}\n`);
}
