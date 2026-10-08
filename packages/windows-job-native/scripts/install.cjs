'use strict';

const { spawnSync } = require('node:child_process');

if (process.platform === 'win32' || process.platform === 'linux') {
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
