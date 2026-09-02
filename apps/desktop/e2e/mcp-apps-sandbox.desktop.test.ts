import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';

const sandboxModulePath = path.resolve(process.cwd(), '../../packages/mcp-app-host/dist/index.js');

test('MCP Apps hidden Electron sandbox denies escapes and cleans repeated windows', async ({
  electronApp,
}) => {
  const result = await electronApp.app.evaluate(async ({ BrowserWindow, session }, moduleUrl) => {
    const moduleBuiltin: unknown = process.getBuiltinModule('node:module');
    if (
      (typeof moduleBuiltin !== 'object' && typeof moduleBuiltin !== 'function') ||
      moduleBuiltin === null
    ) {
      throw new Error('Node module builtin is unavailable');
    }
    const createRequire = Reflect.get(moduleBuiltin, 'createRequire');
    if (typeof createRequire !== 'function') {
      throw new Error('Node createRequire is unavailable');
    }
    const requireFromModule: unknown = Reflect.apply(createRequire, moduleBuiltin, [moduleUrl]);
    if (typeof requireFromModule !== 'function') {
      throw new Error('Node createRequire returned an invalid loader');
    }
    const sandboxModule: unknown = Reflect.apply(requireFromModule, undefined, [moduleUrl]);
    if (typeof sandboxModule !== 'object' || sandboxModule === null) {
      throw new Error('MCP Apps sandbox module did not load');
    }
    const install = Reflect.get(sandboxModule, 'installMcpAppElectronSandboxPolicy');
    const buildPolicy = Reflect.get(sandboxModule, 'buildMcpAppSandboxPolicy');
    const renderResource = Reflect.get(sandboxModule, 'renderMcpAppResourceDocument');
    const renderShell = Reflect.get(sandboxModule, 'renderMcpAppSandboxShellDocument');
    if (
      typeof install !== 'function' ||
      typeof buildPolicy !== 'function' ||
      typeof renderResource !== 'function' ||
      typeof renderShell !== 'function'
    ) {
      throw new Error('MCP Apps sandbox exports are incomplete');
    }

    const scriptClose = '</script>';
    const appHtml = `<!doctype html><script>(async()=>{
        const result={fetchDenied:false,geolocationDenied:false,parentDenied:false,popupDenied:false,topDenied:false};
        try{void parent.document.body}catch{result.parentDenied=true}
        try{top.location.href='https://escape.invalid/'}catch{result.topDenied=true}
        result.popupDenied=window.open('https://popup.invalid/')===null;
        try{await fetch('https://network.invalid/')}catch{result.fetchDenied=true}
        result.geolocationDenied=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve(false),()=>resolve(true)));
        const link=document.createElement('a');link.download='escape.txt';link.href='data:text/plain,escape';link.click();
        top.postMessage({type:'mcp-app-electron-result',value:result},'*');
      })()${scriptClose}`;
    const policy = buildPolicy(undefined);
    const resourceDocument = renderResource(
      {
        generation: 1,
        html: appHtml,
        mimeType: 'text/html;profile=mcp-app',
        serverId: 'electron-verifier',
        source: 'text',
        toolName: 'verifier',
        uri: 'ui://electron/verifier',
      },
      policy
    );
    const rawShell = renderShell(resourceDocument, policy) as string;
    const shell = rawShell.replace(
      '<body><script>',
      `<body><script>window.__mcpResult=new Promise(resolve=>addEventListener('message',event=>{if(event.data?.type==='mcp-app-electron-result')resolve(event.data.value)}));${scriptClose}<script>`
    );
    const partition = `mcp-app:sandbox-verifier-${Date.now()}`;
    const sandboxSession = session.fromPartition(partition, { cache: false });
    let downloads = 0;
    let deniedDownloads = 0;
    const observations: unknown[] = [];

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true,
          webSecurity: true,
        },
      });
      const contents = window.webContents;
      let createdWindows = 0;
      contents.on('did-create-window', () => {
        createdWindows += 1;
      });
      const lease = install({ partition, sessions: session, webContents: contents });
      // Registered AFTER the lease so the lease's denial runs first: a real
      // denial observation is `defaultPrevented`, not that the event fired.
      const observeDownload = (event: Electron.Event): void => {
        downloads += 1;
        if (event.defaultPrevented) {
          deniedDownloads += 1;
        }
      };
      sandboxSession.on('will-download', observeDownload);
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shell)}`);
      const appResult = await contents.executeJavaScript(
        `Promise.race([window.__mcpResult,new Promise((_,reject)=>setTimeout(()=>reject(new Error('sandbox result timeout')),5000))])`
      );
      contents.downloadURL('data:text/plain,host-attempt');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const urlBeforeClose = contents.getURL();
      await lease.close();
      sandboxSession.removeListener('will-download', observeDownload);
      observations.push({
        appResult,
        createdWindows,
        destroyed: contents.isDestroyed(),
        urlBeforeClose,
      });
    }
    return { deniedDownloads, downloads, observations };
  }, sandboxModulePath);

  expect(result.downloads).toBeGreaterThan(0);
  expect(result.deniedDownloads).toBe(result.downloads);
  expect(result.observations).toHaveLength(3);
  for (const observation of result.observations) {
    if (typeof observation !== 'object' || observation === null) {
      throw new TypeError('Electron sandbox observation is malformed');
    }
    expect(observation).toMatchObject({
      appResult: {
        fetchDenied: true,
        geolocationDenied: true,
        parentDenied: true,
        popupDenied: true,
        topDenied: true,
      },
      createdWindows: 0,
      destroyed: true,
    });
    expect(Reflect.get(observation, 'urlBeforeClose')).toMatch(/^data:text\/html/);
  }
});
