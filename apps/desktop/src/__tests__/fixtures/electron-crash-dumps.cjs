'use strict';
// Required (`-r`) into a launched test app's Electron main before its own entry.
// A native crash in any of the app's processes, quit included, leaves a local
// minidump in the test's evidence folder; nothing is uploaded.
const { app, crashReporter } = require('electron');
const path = require('node:path');

// Main reads its own argv (folder-open candidates), so it sees what an
// ordinary launch passes: drop this `-r <file>` pair, as Playwright's loader does.
const self = process.argv.findIndex(
  (argument, index) =>
    index > 0 && process.argv[index - 1] === '-r' && path.resolve(argument) === __filename
);
if (self > 0) {
  process.argv.splice(self - 1, 2);
}

const directory = process.env['BRAINSTRIKE_E2E_CRASH_DUMPS_DIR'];
if (directory) {
  app.setPath('crashDumps', directory);
  crashReporter.start({ compress: false, uploadToServer: false });
}
