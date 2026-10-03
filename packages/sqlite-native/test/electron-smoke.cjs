'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');

const { collectFacts, provenanceFailures } = require('./smoke-lib.cjs');

const requireFromDesktop = createRequire(
  path.resolve(__dirname, '../../../apps/desktop/package.json')
);
const { app } = requireFromDesktop('electron');
const requireFromPackage = createRequire(path.resolve(__dirname, '../package.json'));

app
  .whenReady()
  .then(() => {
    const facts = collectFacts(requireFromPackage);
    const failures = provenanceFailures(facts, { packaged: false });
    process.stdout.write(`${JSON.stringify({ facts, failures }, null, 2)}\n`);
    if (failures.length > 0) {
      throw new Error(`sqlite-native provenance failed:\n${failures.join('\n')}`);
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  });
