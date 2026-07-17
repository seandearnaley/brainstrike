'use strict';

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
    const root = new SecureRoot(path.resolve(__dirname, '..'));
    root.close();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    app.exit(1);
  });
