'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { SecureRoot } = require('..');

const requireFromDesktop = createRequire(
  path.resolve(__dirname, '../../../apps/desktop/package.json')
);
const { app } = requireFromDesktop('electron');

app
  .whenReady()
  .then(() => {
    assert.equal(
      Number.parseInt(requireFromDesktop('@types/node/package.json').version, 10),
      Number.parseInt(process.versions.node, 10),
      'Node declarations must match the actual packaged Electron Node API runtime'
    );
    assert.equal(
      requireFromDesktop('./package.json').config.nodeRuntimeMajor,
      Number.parseInt(process.versions.node, 10),
      'Application Node API floor must match the packaged Electron runtime'
    );
    const root = new SecureRoot(path.resolve(__dirname, '..'));
    root.close();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    app.exit(1);
  });
