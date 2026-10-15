import { app, BrowserWindow, protocol } from 'electron';
import { APP_RENDERER_DOCUMENT_URL, APP_RENDERER_SCHEME } from '../../desktop-renderer-target';
import {
  APP_RENDERER_PROTOCOL_PRIVILEGE,
  createRendererProtocolHandler,
} from '../../renderer-protocol';

const [, , root, profile] = process.argv;
if (!(root && profile)) {
  throw new Error('Origin proof requires disposable bundle and profile');
}
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([APP_RENDERER_PROTOCOL_PRIVILEGE]);

/** Loads the bundled document as the app's loaders do and reads its realms. */
async function prove(url: string): Promise<unknown> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    await window.loadURL(url);
    const receipt: unknown = await window.webContents.executeJavaScript('globalThis.receipt');
    const inspectPreferences: unknown = Reflect.get(window.webContents, 'getLastWebPreferences');
    if (typeof inspectPreferences !== 'function') {
      throw new TypeError('Electron runtime preference inspection is unavailable');
    }
    const preferences: unknown = Reflect.apply(inspectPreferences, window.webContents, []);
    return { preferences, receipt };
  } finally {
    window.close();
  }
}

void (async () => {
  try {
    await app.whenReady();
    protocol.handle(APP_RENDERER_SCHEME, createRendererProtocolHandler(`${root}/index.html`));
    const hidden = await prove(`${APP_RENDERER_DOCUMENT_URL}?mode=embedding-host&runtimeId=proof`);
    const visible = await prove(APP_RENDERER_DOCUMENT_URL);
    console.log(`ORIGIN_PROOF ${JSON.stringify({ hidden, visible })}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
})();
