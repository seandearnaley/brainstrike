import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { ElectronApplication } from 'playwright';
import { _electron as electron } from 'playwright';

const bridgeModulePath = path.resolve(process.cwd(), '../../packages/mcp-app-host/dist/index.js');

function appDocument(label: string): string {
  const scriptClose = '</script>';
  return `<!doctype html><script>
    const send = message => parent.postMessage(message, '*');
    addEventListener('message', event => {
      if (event.source !== parent) return;
      const message = event.data;
      if (message?.id === '${label}-initialize' && message?.result) {
        send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
      }
      if (message?.method === 'ui/notifications/tool-input') {
        send({id:'${label}-wait',jsonrpc:'2.0',method:'tools/call',params:{name:'wait'}});
      }
      if (message?.method === 'ui/notifications/host-context-changed') {
        send({id:'${label}-malformed',jsonrpc:'2.0',method:'tools/list',params:{}});
      }
      if (message?.method === 'ui/resource-teardown' && message?.id !== 'pending') {
        send({id:message.id,jsonrpc:'2.0',result:{}});
      }
    });
    send({
      id:'${label}-initialize',
      jsonrpc:'2.0',
      method:'ui/initialize',
      params:{appCapabilities:{},appInfo:{name:'${label}',version:'1.0.0'},protocolVersion:'2026-01-26'}
    });
  ${scriptClose}`;
}

function packagedExecutablePath(): string {
  const releaseRoot = path.resolve(process.cwd(), 'release');
  if (process.platform === 'darwin') {
    const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(
      releaseRoot,
      outputDirectory,
      'BrainStrike Desktop.app',
      'Contents',
      'MacOS',
      'BrainStrike Desktop'
    );
  }
  if (process.platform === 'win32') {
    const outputDirectory = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
    return path.join(releaseRoot, outputDirectory, 'BrainStrike Desktop.exe');
  }
  if (process.platform === 'linux') {
    const outputDirectory = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    return path.join(releaseRoot, outputDirectory, 'brainstrike-desktop');
  }
  throw new Error(`Packaged MCP Apps verifier does not support ${process.platform}`);
}

function electronEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || value === undefined) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

test('MCP Apps bridge is quiescent in genuinely packaged Electron', {
  tag: ['@destructive', '@packaged'],
}, async () => {
  test.setTimeout(180_000);
  const executablePath = packagedExecutablePath();
  await access(executablePath, constants.X_OK);
  await access(bridgeModulePath, constants.R_OK);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1570-packaged-user-data-'));
  // The harness lives in the disposable user-data directory (never in a
  // published dist/). The host package has bare runtime dependencies
  // (@modelcontextprotocol/*) that a raw browser import cannot resolve, so the
  // built module is bundled into a single ESM file first and imported by
  // absolute file URL.
  const harnessPath = path.join(userDataDir, 'bst-1570-packaged-verifier.html');
  const bridgeBundlePath = path.join(userDataDir, 'bridge-bundle.js');
  await build({
    bundle: true,
    entryPoints: [bridgeModulePath],
    format: 'esm',
    logLevel: 'silent',
    outfile: bridgeBundlePath,
    platform: 'browser',
    target: 'chrome136',
  });
  const bridgeModuleUrl = pathToFileURL(bridgeBundlePath).href;
  await writeFile(
    harnessPath,
    `<!doctype html><script type='module'>import(${JSON.stringify(bridgeModuleUrl)}).then(bridgeModule=>{globalThis.__mcpAppBridgeModule=bridgeModule},error=>{globalThis.__mcpAppBridgeModuleError=error instanceof Error?error.message:String(error)})</script>`,
    'utf8'
  );
  let electronApp: ElectronApplication | undefined;
  try {
    electronApp = await electron.launch({
      args: [
        '--test-mode',
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
      env: {
        ...electronEnvironment(),
        ['BRAINSTRIKE_DISABLE_FILE_LOGS']: '1',
        ['BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES']: '1',
        ['BRAINSTRIKE_E2E_USER_DATA_DIR']: userDataDir,
        ['BRAINSTRIKE_OPENAI_API_KEY']: 'test-api-key-for-e2e-tests',
        ['ELECTRON_IS_E2E_TEST']: 'true',
        ['NODE_OPTIONS']: '',
      },
      executablePath,
      timeout: 120_000,
    });
    const result = await electronApp.evaluate(
      async ({ app, BrowserWindow }, input) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            partition: `bst-1570-packaged-verifier-${process.pid}`,
            sandbox: true,
            webSecurity: true,
          },
        });
        try {
          await window.loadFile(input.harnessPath);
          const lifecycle = await window.webContents.executeJavaScript(`(async()=>{
            const moduleDeadline=performance.now()+3000;
            while(!globalThis.__mcpAppBridgeModule){
              if(globalThis.__mcpAppBridgeModuleError)throw new Error('bridge module load failed: '+globalThis.__mcpAppBridgeModuleError);
              if(performance.now()>moduleDeadline)throw new Error('bridge module load timeout');
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            const {McpAppFrameBridge}=globalThis.__mcpAppBridgeModule;
            const errors=[];
            let liveGeneration=1;
            const bridge=new McpAppFrameBridge({
              eventTarget:window,
              isGenerationLive:generation=>generation===liveGeneration,
              onNotification:()=>undefined,
              onProtocolError:error=>errors.push(error.message),
              onRequest:(message,{signal})=>{
                if(message.method==='tools/call'&&message.params?.name==='wait'){
                  return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
                }
                // Host replies are validated against the pinned canonical
                // result schema for the method they answer.
                if(message.method==='ui/initialize'){
                  return {hostCapabilities:{},hostContext:{platform:'desktop'},hostInfo:{name:'Brainstrike',version:'1.0.0'},protocolVersion:'2026-01-26'};
                }
                return {};
              },
              timeoutMs:1000,
            });
            const waitFor=async(label,predicate)=>{
              const deadline=performance.now()+3000;
              while(!predicate()){
                if(performance.now()>deadline)throw new Error(label+' timeout: '+JSON.stringify({errors,snapshot:bridge.snapshot}));
                await new Promise(resolve=>setTimeout(resolve,10));
              }
            };
            const createFrame=()=>{
              const frame=document.createElement('iframe');
              frame.sandbox.add('allow-scripts');
              document.body.append(frame);
              if(!frame.contentWindow)throw new Error('frame contentWindow unavailable');
              return frame;
            };

            const first=createFrame();
            bridge.connect({generation:1,origin:'null',source:first.contentWindow});
            first.srcdoc=${JSON.stringify(input.firstHtml)};
            await waitFor('first handshake',()=>bridge.snapshot.phase==='ready');
            bridge.sendNotification({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{}});
            await waitFor('inbound callback',()=>bridge.snapshot.pendingInboundRequests===1);
            const pending=bridge.sendRequest({id:'pending',jsonrpc:'2.0',method:'ui/resource-teardown',params:{}});
            const pendingOutcome=pending.then(()=> 'resolved',error=>error instanceof Error?error.message:'rejected');

            liveGeneration=2;
            const second=createFrame();
            bridge.replace({generation:2,origin:'null',source:second.contentWindow});
            second.srcdoc=${JSON.stringify(input.secondHtml)};
            const afterReplacement=bridge.snapshot;
            await waitFor('replacement handshake',()=>bridge.snapshot.phase==='ready');
            const pendingError=await pendingOutcome;
            bridge.sendNotification({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{}});
            await waitFor('bound-frame failure',()=>bridge.snapshot.phase==='disconnected');
            const afterFailure=bridge.snapshot;

            // A reconnect after teardown needs a newer generation AND a fresh
            // source (McpAppFrameSession freshness guards).
            liveGeneration=3;
            const reconnected=createFrame();
            bridge.connect({generation:3,origin:'null',source:reconnected.contentWindow});
            reconnected.srcdoc=${JSON.stringify(input.secondHtml)};
            await waitFor('reconnect handshake',()=>bridge.snapshot.phase==='ready');
            bridge.disconnect();
            const afterDisconnect=bridge.snapshot;

            liveGeneration=4;
            const third=createFrame();
            bridge.connect({generation:4,origin:'null',source:third.contentWindow});
            third.srcdoc=${JSON.stringify(input.thirdHtml)};
            await waitFor('final handshake',()=>bridge.snapshot.phase==='ready');
            bridge.close();
            return {afterClose:bridge.snapshot,afterDisconnect,afterFailure,afterReplacement,errors,pendingError};
          })()`);
          return { isPackaged: app.isPackaged, lifecycle };
        } finally {
          if (!window.isDestroyed()) {
            window.close();
          }
        }
      },
      {
        firstHtml: appDocument('first'),
        harnessPath,
        secondHtml: appDocument('second'),
        thirdHtml: appDocument('third'),
      }
    );

    expect(result.isPackaged).toBe(true);
    expect(result.lifecycle.pendingError).toBe('MCP Apps frame was replaced');
    expect(result.lifecycle.errors).toEqual(
      expect.arrayContaining(['MCP Apps message method must be a stable MCP Apps method'])
    );
    expect(result.lifecycle.afterReplacement).toMatchObject({
      listenerCount: 1,
      phase: 'awaiting-initialize',
    });
    for (const snapshot of [
      result.lifecycle.afterReplacement,
      result.lifecycle.afterFailure,
      result.lifecycle.afterDisconnect,
    ]) {
      expect(snapshot).toMatchObject({
        pendingCallbacks: 0,
        pendingInboundRequests: 0,
        pendingNotifications: 0,
        pendingOutboundRequests: 0,
        timerCount: 0,
      });
    }
    for (const snapshot of [result.lifecycle.afterFailure, result.lifecycle.afterDisconnect]) {
      expect(snapshot).toMatchObject({ listenerCount: 0, phase: 'disconnected' });
    }
    expect(result.lifecycle.afterClose).toEqual({
      listenerCount: 0,
      pendingCallbacks: 0,
      pendingInboundRequests: 0,
      pendingNotifications: 0,
      pendingOutboundRequests: 0,
      phase: 'closed',
      timerCount: 0,
    });
  } finally {
    await electronApp?.close();
    await rm(harnessPath, { force: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});
