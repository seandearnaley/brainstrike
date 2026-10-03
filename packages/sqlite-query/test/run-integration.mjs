import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
const child = spawn(
  executable,
  [
    fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    'src/__tests__/sandbox.integration.test.ts',
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
  const utility = spawn(
    executable,
    [fileURLToPath(new URL('./electron-utility.cjs', import.meta.url))],
    {
      env: utilityEnvironment,
      stdio: 'inherit',
    }
  );
  utility.on('error', (error) => {
    throw error;
  });
  utility.on('exit', (exitCode, exitSignal) => {
    if (exitSignal) {
      throw new Error(`SQLite query utility proof exited with ${exitSignal}.`);
    }
    process.exitCode = exitCode ?? 1;
  });
});
