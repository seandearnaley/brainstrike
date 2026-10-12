'use strict';
// Electron half of provision-test-model-cache.mjs: a hidden file:// page fetches
// each public model file and stores it in Cache Storage under
// "transformers-cache", keyed by its URL, exactly as transformers.js caches it.
// A graceful quit flushes Chromium's cache index to disk.
const { app, BrowserWindow } = require('electron');

const page = process.env.BRAINSTRIKE_PROVISION_PAGE;
const urls = JSON.parse(process.env.BRAINSTRIKE_PROVISION_URLS ?? '[]');
const userData = process.env.BRAINSTRIKE_PROVISION_USER_DATA;
if (!(page && userData && Array.isArray(urls) && urls.length > 0)) {
  throw new Error('Model cache provisioning needs its page, URLs and user-data directory.');
}
app.setPath('userData', userData);

async function provision(requested) {
  const cache = await caches.open('transformers-cache');
  const stored = [];
  for (const url of requested) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    await cache.put(url, response);
    stored.push(url);
  }
  return stored;
}

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await window.loadFile(page);
    const stored = await window.webContents.executeJavaScript(
      `(${provision.toString()})(${JSON.stringify(urls)})`
    );
    if (JSON.stringify(stored) !== JSON.stringify(urls)) {
      throw new Error('Model cache provisioning stored a different set of files.');
    }
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  });
