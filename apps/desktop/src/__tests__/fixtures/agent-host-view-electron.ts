import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { app, BrowserWindow } from 'electron';
import { openAgentHostPortRelay } from '../../agent-host-port-relay';

const root = process.env['BRAINSTRIKE_M3_OWNED_ROOT'];
const html = process.env['BRAINSTRIKE_M3_OWNED_HTML'];
const preload = process.env['BRAINSTRIKE_M3_OWNED_PRELOAD'];
const threadId = process.env['BRAINSTRIKE_M3_OWNED_THREAD'];
if (!(root && html && preload && threadId)) {
  throw new Error('Owned M3 view fixture requires root, HTML, preload and thread');
}
app.setPath('userData', join(root, 'owned-electron-view'));
app
  .whenReady()
  .then(async () => {
    const record = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
    const relay = await openAgentHostPortRelay(record);
    const window = new BrowserWindow({
      height: 720,
      show: true,
      webPreferences: { contextIsolation: true, preload, sandbox: true },
      width: 960,
    });
    window.once('closed', () => {
      void relay.close();
    });
    void relay.closed.then(() => {
      if (!window.isDestroyed()) {
        window.webContents.send('agent-host/disconnected');
      }
    });
    await window.loadFile(html, { query: { threadId } });
    window.webContents.postMessage('agent-host/connect', record, [relay.port]);
  })
  .catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
