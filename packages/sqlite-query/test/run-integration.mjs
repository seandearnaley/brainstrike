import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRequire = createRequire(
  new URL('../../../apps/desktop/package.json', import.meta.url)
);
const executable = process.env.SQLITE_QUERY_TEST_EXEC_PATH ?? desktopRequire('electron');
if (typeof executable !== 'string') {
  throw new TypeError('The integration runner requires an Electron executable path.');
}
const nodeEnvironment = { ...process.env };
nodeEnvironment.ELECTRON_RUN_AS_NODE = '1';
nodeEnvironment.SQLITE_QUERY_TEST_EXEC_PATH = executable;
nodeEnvironment.INDEXER_TEST_EXEC_PATH = process.execPath;
const child = spawn(
  executable,
  [
    fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    'src/__tests__/sandbox.integration.test.ts',
    'src/__tests__/callers-lens.integration.test.ts',
    'src/__tests__/scoped-grep.integration.test.ts',
  ],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: nodeEnvironment,
    stdio: 'inherit',
  }
);
child.on('error', (error) => {
  throw error;
});
child.on('exit', (code, signal) => {
  if (signal) {
    throw new Error(`SQLite query integration runtime exited with ${signal}.`);
  }
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  const utilityEnvironment = { ...process.env };
  utilityEnvironment.ELECTRON_RUN_AS_NODE = undefined;
  const profileDirectory = mkdtempSync(join(tmpdir(), 'brainstrike-query-utility-profile-'));
  utilityEnvironment.SQLITE_QUERY_TEST_USER_DATA_DIR = profileDirectory;
  const utility = spawn(
    executable,
    [fileURLToPath(new URL('./electron-utility.cjs', import.meta.url))],
    {
      env: utilityEnvironment,
      stdio: 'inherit',
    }
  );
  utility.on('error', (error) => {
    rmSync(profileDirectory, { force: true, recursive: true });
    throw error;
  });
  utility.on('close', (exitCode, exitSignal) => {
    rmSync(profileDirectory, { force: true, recursive: true });
    if (exitSignal) {
      throw new Error(`SQLite query utility proof exited with ${exitSignal}.`);
    }
    process.exitCode = exitCode ?? 1;
  });
});
