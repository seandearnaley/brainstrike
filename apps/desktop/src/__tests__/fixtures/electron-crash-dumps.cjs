'use strict';
// Required (`-r`) into a launched test app's Electron main before its own entry.
// A native crash in any of the app's processes, quit included, leaves a local
// minidump in the test's evidence folder; nothing is uploaded.
const { app, crashReporter } = require('electron');

const directory = process.env['BRAINSTRIKE_E2E_CRASH_DUMPS_DIR'];
if (directory) {
  app.setPath('crashDumps', directory);
  crashReporter.start({ compress: false, uploadToServer: false });
}
