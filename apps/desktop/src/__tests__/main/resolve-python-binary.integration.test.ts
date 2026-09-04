import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PYTHON_RUNTIME_SENTINEL_FILE_NAME,
  resolvePythonBinary,
} from '../../python-runtime/resolve-python-binary';

const execFileAsync = promisify(execFile);

// BST-1061 / BST-1627 acceptance smoke: the REAL pinned python-build-standalone
// CPython, unpacked at BUILD time by `scripts/fetch-python-runtime.mjs` into
// resources/python-runtime/unpacked/<arch>/ (the exact tree electron-builder
// copies into the bundle for signing), resolved and spawned for real.
// Integration lane by construction (native binaries). Skips name exactly what
// is missing — never by weakening an assertion.
const manifestDir = path.resolve(import.meta.dirname, '../../../resources/python-runtime');
const installDir = path.join(manifestDir, 'unpacked', process.arch);

function resolveSkipReason(): string | undefined {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    return `bundled Python ships for darwin arm64/x64 only; this host is ${process.platform}/${process.arch}`;
  }
  if (!existsSync(path.join(manifestDir, 'manifest.json'))) {
    return `python-runtime manifest missing at ${manifestDir}`;
  }
  if (!existsSync(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME))) {
    return `unpacked runtime missing at ${installDir} — run \`node apps/desktop/scripts/fetch-python-runtime.mjs\` first`;
  }
  return;
}

const skipReason = resolveSkipReason();

describe('resolvePythonBinary (real unpacked runtime)', () => {
  it.skipIf(skipReason !== undefined)(
    `resolves the build-time-unpacked CPython and runs print(1+1)${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`,
    async () => {
      const binary = await resolvePythonBinary({ installDir, manifestDir });
      expect(path.isAbsolute(binary)).toBe(true);
      expect(binary.startsWith(installDir)).toBe(true);
      const { stdout } = await execFileAsync(binary, ['-c', 'print(1+1)']);
      expect(stdout.trim()).toBe('2');
    },
    60_000
  );
});
