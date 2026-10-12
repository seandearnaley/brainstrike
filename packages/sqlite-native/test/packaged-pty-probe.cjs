'use strict';

// npmRebuild:false also affects node-pty. Exercise a real packaged terminal:
// Linux uses its install-time N-API build; macOS/Windows ship N-API prebuilds.
// https://nodejs.org/api/n-api.html#implications-of-abi-stability
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const out = process.env.SQLITE_NATIVE_PTY_OUT;
if (!out) {
  throw new Error('SQLITE_NATIVE_PTY_OUT is required');
}

async function main() {
  const requireFromAsar = createRequire(
    path.join(process.resourcesPath, 'app.asar', 'package.json')
  );
  const pty = requireFromAsar('node-pty');
  const marker = 'brainstrike-packaged-pty';
  const windows = process.platform === 'win32';
  if (windows && !process.env.SystemRoot) {
    throw new Error('SystemRoot is required to resolve the Windows shell');
  }
  const shell = windows ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : '/bin/sh';
  const args = windows ? ['/d', '/c', `echo ${marker}`] : ['-c', `printf '${marker}\\n'`];
  const terminal = pty.spawn(shell, args, {
    cols: 80,
    cwd: os.tmpdir(),
    env: process.env,
    name: 'xterm',
    rows: 24,
  });
  let output = '';
  const data = terminal.onData((chunk) => {
    output += chunk;
  });
  try {
    const exit = await new Promise((resolve) => {
      const listener = terminal.onExit((event) => {
        listener.dispose();
        resolve(event);
      });
    });
    assert.equal(exit.exitCode, 0, 'packaged terminal shell failed');
    assert.ok(output.includes(marker), `packaged terminal did not return its marker: ${output}`);
    const nodes = Object.keys(require.cache).filter((file) => file.endsWith('.node'));
    assert.ok(nodes.length > 0, 'packaged terminal loaded no native binding');
    for (const file of nodes) {
      assert.ok(
        file.startsWith(path.join(process.resourcesPath, 'app.asar')),
        `non-packaged PTY: ${file}`
      );
    }
    writeFileSync(
      out,
      JSON.stringify({ nodes, ok: true, output, platform: `${process.platform}-${process.arch}` })
    );
  } finally {
    data.dispose();
  }
}

main().catch((error) => {
  writeFileSync(
    out,
    JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })
  );
  process.exitCode = 1;
});
