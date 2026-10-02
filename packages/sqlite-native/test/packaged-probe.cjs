'use strict';

/**
 * Runs INSIDE the packaged executable (`ELECTRON_RUN_AS_NODE=1 <packaged exe>
 * packaged-probe.cjs`, started by packaged-smoke.cjs). It loads the package with
 * its native dependencies resolved from the packaged `app.asar`, exercises it,
 * and writes what loaded to SQLITE_NATIVE_SMOKE_OUT. The driver judges the
 * facts; a failure to load is written as `{ error }` so the real message reaches
 * the driver's output.
 *
 * The result goes to a file, not stdout: a GUI-subsystem executable on Windows
 * does not reliably attach stdout.
 */

const { writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const { collectFacts, packagedTreeFacts } = require('./smoke-lib.cjs');

const out = process.env.SQLITE_NATIVE_SMOKE_OUT;
if (!out) {
  throw new Error('SQLITE_NATIVE_SMOKE_OUT is required');
}

const resources = process.resourcesPath;
// Anchored at the app's package.json inside the archive, so bare requires
// resolve from app.asar/node_modules exactly as the bundled main process does.
const requireFromAsar = createRequire(path.join(resources, 'app.asar', 'package.json'));

try {
  const facts = collectFacts(requireFromAsar);
  writeFileSync(
    out,
    JSON.stringify({
      ...facts,
      resourcesPath: resources,
      tree: packagedTreeFacts(resources, requireFromAsar),
    })
  );
} catch (error) {
  writeFileSync(
    out,
    JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })
  );
  process.exit(1);
}
