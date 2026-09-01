import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { type Browser, chromium, type Page } from 'playwright';

const appHostModulePath = path.resolve(process.cwd(), '../../packages/mcp-app-host/dist/index.js');
const appSurfaceModulePath = path.resolve(
  process.cwd(),
  '../../packages/mcp-app-host-ui/dist/index.js'
);
const requireFromTest = createRequire(import.meta.url);
const mcpAppsModulePath = requireFromTest.resolve('@modelcontextprotocol/ext-apps');
const reactModulePath = requireFromTest.resolve('react');
const reactDomClientModulePath = requireFromTest.resolve('react-dom/client');

interface AuthoritySnapshot {
  readonly listenerCount: number;
  readonly pendingApprovals: readonly unknown[];
  readonly pendingCalls: number;
  readonly phase: 'closed' | 'open';
}

interface BridgeSnapshot {
  readonly listenerCount: number;
  readonly pendingCallbacks: number;
  readonly pendingInboundRequests: number;
  readonly pendingNotifications: number;
  readonly pendingOutboundRequests: number;
  readonly phase: 'closed' | 'disconnected' | 'ready';
  readonly timerCount: number;
}

interface ResourceSnapshot {
  readonly activeFetches: number;
  readonly activeFrames: number;
  readonly activeUrls: number;
  readonly domFrames: number;
}

interface LifecycleSnapshot {
  readonly authority: AuthoritySnapshot;
  readonly bridge: BridgeSnapshot;
  readonly resources: ResourceSnapshot;
}

interface LoopbackServerSnapshot {
  readonly abortedRequests: number;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly listening: boolean;
  readonly openSockets: number;
  readonly totalRequests: number;
}

interface LoopbackToolServer {
  readonly close: () => Promise<void>;
  readonly origin: string;
  readonly snapshot: () => LoopbackServerSnapshot;
}

interface PackagedHarnessApplication {
  readonly browser: Browser;
  readonly child: ChildProcessWithoutNullStreams;
  readonly closeSandbox: () => Promise<boolean>;
  readonly isPackaged: boolean;
  readonly page: Page;
  readonly sandboxPopupDenied: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createLoopbackToolServer(): Promise<LoopbackToolServer> {
  const sockets = new Set<Socket>();
  let abortedRequests = 0;
  let activeRequests = 0;
  let completedRequests = 0;
  let totalRequests = 0;
  const server: Server = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      body += chunk;
    }
    const payload: unknown = JSON.parse(body);
    if (request.method !== 'POST' || request.url !== '/tool' || !isRecord(payload)) {
      response.writeHead(400, { Connection: 'close' });
      response.end();
      return;
    }
    totalRequests += 1;
    activeRequests += 1;
    let settled = false;
    const settle = (outcome: 'aborted' | 'completed'): void => {
      if (settled) {
        return;
      }
      settled = true;
      activeRequests -= 1;
      if (outcome === 'aborted') {
        abortedRequests += 1;
      } else {
        completedRequests += 1;
      }
    };
    response.once('finish', () => settle('completed'));
    response.once('close', () => {
      if (!response.writableEnded) {
        settle('aborted');
      }
    });
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Connection', 'close');
    response.setHeader('Content-Type', 'application/json');
    if (payload['mode'] === 'hold') {
      return;
    }
    if (payload['mode'] === 'failure') {
      response.writeHead(503);
      response.end(JSON.stringify({ code: 'fixture_failure' }));
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({ content: [{ text: 'created', type: 'text' }] }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('BST-1571 loopback tool server address is unavailable');
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    },
    origin: `http://127.0.0.1:${address.port}`,
    snapshot: () => ({
      abortedRequests,
      activeRequests,
      completedRequests,
      listening: server.listening,
      openSockets: sockets.size,
      totalRequests,
    }),
  };
}

function sandboxedAppSource(): string {
  return `
    import {App,PostMessageTransport} from ${JSON.stringify(mcpAppsModulePath)};
    const pending=new Set();
    const app=new App(
      {name:'BST-1571 verifier',version:'1.0.0'},
      {},
      {autoResize:false,strict:true}
    );
    app.ontoolinput=({arguments:argumentsValue={}})=>{
      const label=argumentsValue.label;
      pending.add(label);
      void app.callServerTool({arguments:argumentsValue,name:'create_issue'}).then(
        async()=>{
          pending.delete(label);
          await app.sendLog({data:{callId:label,outcome:'resolved'},level:'info'});
        },
        async()=>{
          pending.delete(label);
          await app.sendLog({data:{callId:label,outcome:'rejected'},level:'info'});
        }
      );
    };
    app.onhostcontextchanged=()=>{
      top.postMessage({id:'protocol-failure',jsonrpc:'2.0',method:'tools/list',params:{}},'*');
    };
    app.onteardown=async(_params,extra)=>{
      if(String(extra.requestId).startsWith('pending-')){
        return await new Promise(()=>{});
      }
      return {released:true};
    };
    void app.connect(new PostMessageTransport(top,top)).catch(error=>{
      console.error('MCP Apps verifier connect failed',error);
    });
  `;
}

function sandboxedAppDocument(appBundle: string): string {
  const scriptClose = '</script>';
  return `<!doctype html><script>${appBundle.replaceAll(scriptClose, '<\\/script>')}${scriptClose}`;
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
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

async function evaluateElectronMain(endpoint: string, expression: string): Promise<unknown> {
  const socket = new WebSocket(endpoint);
  const connectionTimeout = AbortSignal.timeout(10_000);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true, signal: connectionTimeout });
    socket.addEventListener(
      'error',
      () => reject(new Error('Electron inspector connection failed')),
      { once: true, signal: connectionTimeout }
    );
    connectionTimeout.addEventListener(
      'abort',
      () => reject(new Error('Electron inspector connection timed out')),
      { once: true }
    );
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Electron inspector evaluation timed out')),
        10_000
      );
      socket.addEventListener('message', (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (!isRecord(message) || message['id'] !== 1) {
          return;
        }
        clearTimeout(timeout);
        const result = message['result'];
        const remote = isRecord(result) ? result['result'] : undefined;
        if (!isRecord(remote) || Object.hasOwn(result ?? {}, 'exceptionDetails')) {
          reject(
            new Error(
              `Electron inspector evaluation failed: ${JSON.stringify({
                error: message['error'],
                exceptionDetails: isRecord(result) ? result['exceptionDetails'] : undefined,
              })}`
            )
          );
          return;
        }
        resolve(remote['value']);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            awaitPromise: true,
            expression,
            includeCommandLineAPI: true,
            returnByValue: true,
          },
        })
      );
    });
  } finally {
    socket.close();
  }
}

async function launchPackagedHarness(
  executablePath: string,
  harnessPath: string,
  userDataDir: string
): Promise<PackagedHarnessApplication> {
  const child = spawn(
    executablePath,
    [
      '--inspect=0',
      '--remote-debugging-port=0',
      '--test-mode',
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    {
      env: {
        ...electronEnvironment(),
        BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
        BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
        BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
        BRAINSTRIKE_OPENAI_API_KEY: 'test-api-key-for-e2e-tests',
        ELECTRON_IS_E2E_TEST: 'true',
        NODE_OPTIONS: '',
      },
      stdio: 'pipe',
    }
  );
  try {
    const recentLogs: string[] = [];
    const endpoints = await new Promise<{
      readonly browser: string;
      readonly main: string;
    }>((resolve, reject) => {
      let browserEndpoint: string | undefined;
      let mainEndpoint: string | undefined;
      const timeout = setTimeout(
        () => reject(new Error(`Packaged Electron DevTools timeout: ${recentLogs.join('\n')}`)),
        120_000
      );
      const finish = (callback: () => void): void => {
        clearTimeout(timeout);
        stdout.close();
        stderr.close();
        child.stdout.resume();
        child.stderr.resume();
        child.off('exit', onExit);
        callback();
      };
      const onLine = (line: string): void => {
        recentLogs.push(line);
        if (recentLogs.length > 40) {
          recentLogs.shift();
        }
        browserEndpoint = line.match(/^DevTools listening on (ws:\/\/.*)$/)?.[1] ?? browserEndpoint;
        mainEndpoint = line.match(/^Debugger listening on (ws:\/\/.*)$/)?.[1] ?? mainEndpoint;
        if (browserEndpoint && mainEndpoint) {
          const matched = { browser: browserEndpoint, main: mainEndpoint };
          finish(() => resolve(matched));
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(() =>
          reject(
            new Error(
              `Packaged Electron exited before DevTools (${String(code)}/${String(signal)}): ${recentLogs.join('\n')}`
            )
          )
        );
      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });
      stdout.on('line', onLine);
      stderr.on('line', onLine);
      child.once('exit', onExit);
    });
    const launchResult = await evaluateElectronMain(
      endpoints.main,
      `(async()=>{const requireFromMain=process.getBuiltinModule('node:module').createRequire(process.execPath);const{app,BrowserWindow}=requireFromMain('electron');await app.whenReady();const window=new BrowserWindow({show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,partition:'bst-1571-packaged-host',sandbox:true,webSecurity:true}});globalThis.__bst1571PackagedWindow=window;await window.loadFile(${JSON.stringify(harnessPath)});const sandboxWindow=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,partition:'bst-1571-packaged-sandbox',sandbox:true,webSecurity:true}});globalThis.__bst1571SandboxWindow=sandboxWindow;const host=requireFromMain(${JSON.stringify(appHostModulePath)});globalThis.__bst1571SandboxLease=host.installMcpAppElectronSandboxPolicy({session:sandboxWindow.webContents.session,webContents:sandboxWindow.webContents});await sandboxWindow.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3EBST-1571%20sandbox%3C%2Ftitle%3E');const sandboxPopupDenied=await sandboxWindow.webContents.executeJavaScript("window.open('https://escape.invalid/')===null");return{isPackaged:app.isPackaged,sandboxPopupDenied}})()`
    );
    if (
      !isRecord(launchResult) ||
      typeof launchResult['isPackaged'] !== 'boolean' ||
      typeof launchResult['sandboxPopupDenied'] !== 'boolean'
    ) {
      throw new Error('BST-1571 packaged launch result is malformed');
    }
    const closeSandbox = async (): Promise<boolean> => {
      const destroyed = await evaluateElectronMain(
        endpoints.main,
        `(async()=>{const lease=globalThis.__bst1571SandboxLease;if(!lease)throw new Error('BST-1571 sandbox lease is unavailable');await lease.close();globalThis.__bst1571SandboxLease=undefined;const window=globalThis.__bst1571SandboxWindow;globalThis.__bst1571SandboxWindow=undefined;return !window||window.isDestroyed()})()`
      );
      return destroyed === true;
    };
    const browser = await chromium.connectOverCDP(endpoints.browser);
    const expectedUrl = pathToFileURL(harnessPath).href;
    let page: Page | undefined;
    await expect
      .poll(() => {
        page = browser
          .contexts()[0]
          ?.pages()
          .find((candidate) => candidate.url() === expectedUrl);
        return page?.url();
      })
      .toBe(expectedUrl);
    if (!page) {
      throw new Error('BST-1571 packaged harness page is unavailable');
    }
    return {
      browser,
      child,
      closeSandbox,
      isPackaged: launchResult['isPackaged'],
      page,
      sandboxPopupDenied: launchResult['sandboxPopupDenied'],
    };
  } catch (error: unknown) {
    child.kill('SIGTERM');
    await waitForProcessExit(child).catch(() => child.kill('SIGKILL'));
    throw error;
  }
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Packaged Electron did not exit after SIGTERM')),
      15_000
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function harnessSource(serverOrigin: string, appDocument: string): string {
  return `
    import {McpUiInitializeResultSchema} from ${JSON.stringify(mcpAppsModulePath)};
    import React, {createRef} from ${JSON.stringify(reactModulePath)};
    import {createRoot} from ${JSON.stringify(reactDomClientModulePath)};
    import {McpAppHostSurface} from ${JSON.stringify(appSurfaceModulePath)};
    import {
      McpAppFrameBridge,
      McpAppProvenanceAuthority,
      McpAppSandboxOwner,
      McpAppToolCallAuthority,
    } from ${JSON.stringify(appHostModulePath)};

    const APP_NAME='Linear issue editor';
    const APP_DOCUMENT=${JSON.stringify(appDocument)};
    const SERVER_ORIGIN=${JSON.stringify(serverOrigin)};
    const initializeResult=McpUiInitializeResultSchema.safeParse({
      hostCapabilities:{logging:{},sandbox:{},serverResources:{},serverTools:{}},
      hostContext:{platform:'desktop'},
      hostInfo:{name:'Brainstrike',version:'1.0.0'},
      protocolVersion:'2026-01-26',
    });
    if(!initializeResult.success){
      throw new Error('BST-1571 canonical MCP Apps initialization result is invalid');
    }
    const INITIALIZE_RESULT=Object.freeze(initializeResult.data);
    const activeUrls=new Set();
    const appReceipts=new Map();
    const outcomes=new Map();
    const pendingRpcOutcomes=new Map();
    const provenance=new McpAppProvenanceAuthority();
    const recoveryFocusRef=createRef();
    const sandboxFrameRef=createRef();
    const sandboxOwner=new McpAppSandboxOwner({
      urls:{
        createObjectURL(blob){
          const url=URL.createObjectURL(blob);
          activeUrls.add(url);
          return url;
        },
        revokeObjectURL(url){
          URL.revokeObjectURL(url);
          activeUrls.delete(url);
        },
      },
    });
    let activeFetches=0;
    let current;
    let generationSequence=0;
    let lastAuthority;
    let protocolTeardown;
    let root=createRoot(document.getElementById('root'));

    const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

    async function waitFor(label,predicate,timeoutMs=5000){
      const deadline=performance.now()+timeoutMs;
      while(!predicate()){
        if(performance.now()>deadline){
          throw new Error(label+' timeout: '+JSON.stringify({
            bridge:current?.bridge.snapshot,
            resources:resourceSnapshot(),
          }));
        }
        await delay(10);
      }
    }

    function resourceSnapshot(){
      return {
        activeFetches,
        activeFrames:sandboxOwner.activeFrames,
        activeUrls:activeUrls.size,
        domFrames:document.querySelectorAll('[data-mcp-app-sandbox]').length,
      };
    }

    function lifecycleSnapshot(session){
      return {
        authority:session.authority.snapshot,
        bridge:session.bridge.snapshot,
        resources:resourceSnapshot(),
      };
    }

    function render(state,authority=lastAuthority,shellUrl){
      if(!authority)throw new Error('MCP Apps verifier authority is unavailable');
      root.render(React.createElement(
        React.Fragment,
        null,
        React.createElement('button',{id:'recovery',ref:recoveryFocusRef,'aria-label':'Return to Linear result',type:'button'},'Return'),
        React.createElement(
          McpAppHostSurface,
          {
            appName:APP_NAME,
            authority,
            onCancel:()=>void globalThis.__bst1571.disconnect(),
            onRetry:()=>void globalThis.__bst1571.reset(),
            recoveryFocusRef,
            state,
          },
          state.phase==='ready'&&shellUrl
            ? React.createElement('iframe',{
                'aria-label':'Sandboxed Linear app',
                'data-mcp-app-sandbox':'true',
                key:shellUrl,
                ref:sandboxFrameRef,
                src:shellUrl,
                title:'Sandboxed Linear app',
              })
            : null
        )
      ));
    }

    async function executeServerCall(call,signal){
      activeFetches+=1;
      try{
        const response=await fetch(SERVER_ORIGIN+'/tool',{
          body:JSON.stringify(call.input),
          method:'POST',
          signal,
        });
        if(!response.ok)throw new Error('MCP Apps verifier server request failed');
        return await response.json();
      }finally{
        activeFetches-=1;
      }
    }

    async function createSession(){
      generationSequence+=1;
      const generation=provenance.openGeneration({generation:generationSequence,serverId:'linear'});
      const tool=provenance.registerTool(generation,{
        _meta:{ui:{resourceUri:'ui://linear/issue-editor',visibility:['app']}},
        name:'create_issue',
      });
      const resource=provenance.resolveResource(generation,tool,{
        mimeType:'text/html;profile=mcp-app',
        text:APP_DOCUMENT,
        uri:'ui://linear/issue-editor',
      });
      const mount=sandboxOwner.open(resource);
      const authority=new McpAppToolCallAuthority({
        generation,
        prepare:async call=>({
          decision:'ask',
          execute:async({signal})=>await executeServerCall(call,signal),
          riskCategory:'execute',
        }),
        provenance,
      });
      lastAuthority=authority;
      render({phase:'ready'},authority,mount.shellUrl);
      await waitFor('sandbox shell frame',()=>sandboxFrameRef.current?.contentWindow);
      const outerFrame=sandboxFrameRef.current;
      await waitFor('sandbox app frame',()=>outerFrame.contentDocument?.querySelector('iframe')?.contentWindow);
      const appFrame=outerFrame.contentDocument.querySelector('iframe');
      const appWindow=appFrame?.contentWindow;
      if(!appWindow)throw new Error('MCP Apps verifier frame source is unavailable');
      let bridge;
      bridge=new McpAppFrameBridge({
        eventTarget:window,
        isGenerationLive:value=>value===generation.generation,
        onNotification:message=>{
          if(message.method==='notifications/message'){
            const data=message.params?.data;
            if(data&&typeof data==='object')appReceipts.set(data.callId,data.outcome);
          }
        },
        onProtocolError:error=>{
          if(current?.bridge===bridge&&!current.tearingDown){
            protocolTeardown=teardown({code:'protocol-failed',phase:'error'},'failed');
          }
        },
        onRequest:async(message,context)=>{
          if(message.method==='ui/initialize')return INITIALIZE_RESULT;
          if(message.method!=='tools/call')return {};
          const argumentsValue=message.params?.arguments??{};
          const label=argumentsValue.label;
          try{
            const result=await authority.call({
              arguments:argumentsValue,
              id:message.id,
              name:message.params?.name,
            },{signal:context.signal});
            outcomes.set(label,'resolved');
            return result;
          }catch(error){
            outcomes.set(label,'rejected');
            throw error;
          }
        },
        timeoutMs:5000,
      });
      current={authority,bridge,generation,mount,outerFrame,tearingDown:false};
      bridge.connect({generation:generation.generation,origin:'null',source:appWindow});
      const bootstrapDeadline=performance.now()+5000;
      while(bridge.snapshot.phase==='awaiting-initialize'){
        if(performance.now()>bootstrapDeadline){
          throw new Error('MCP Apps bootstrap timeout: '+JSON.stringify(bridge.snapshot));
        }
        await delay(10);
      }
      await waitFor('MCP Apps handshake',()=>bridge.snapshot.phase==='ready');
      await waitFor('host surface subscription',()=>authority.snapshot.listenerCount===1);
      return lifecycleSnapshot(current);
    }

    async function teardown(state,mode='close'){
      const session=current;
      if(!session)throw new Error('MCP Apps verifier session is unavailable');
      session.tearingDown=true;
      if(mode==='disconnect')session.bridge.disconnect();
      else if(mode!=='failed')session.bridge.close();
      const authoritySnapshot=await session.authority.close();
      provenance.retireGeneration(session.generation);
      session.outerFrame.remove();
      await session.mount.close();
      if(current===session)current=undefined;
      render(state,session.authority);
      return {
        authority:authoritySnapshot,
        bridge:session.bridge.snapshot,
        resources:resourceSnapshot(),
      };
    }

    function begin(label,mode='success'){
      const session=current;
      if(!session)throw new Error('MCP Apps verifier session is unavailable');
      outcomes.set(label,'pending');
      session.bridge.sendNotification({
        jsonrpc:'2.0',
        method:'ui/notifications/tool-input',
        params:{arguments:{label,mode,secret:'must-not-render-in-host-ui'}},
      });
    }

    function beginPendingRpc(label){
      const session=current;
      if(!session)throw new Error('MCP Apps verifier session is unavailable');
      const pending=session.bridge.sendRequest({
        id:'pending-'+label,
        jsonrpc:'2.0',
        method:'ui/resource-teardown',
        params:{},
      });
      pending.then(
        ()=>pendingRpcOutcomes.set(label,'resolved'),
        ()=>pendingRpcOutcomes.set(label,'rejected')
      );
    }

    const initialReady=createSession();
    globalThis.__bst1571={
      begin,
      beginPendingRpc,
      complete:()=>teardown({phase:'completed'}),
      disconnect:()=>teardown({phase:'cancelled'},'disconnect'),
      fail:()=>teardown({code:'protocol-failed',phase:'error'}),
      initialReady:()=>initialReady,
      outcome:label=>outcomes.get(label),
      pendingRpcOutcome:label=>pendingRpcOutcomes.get(label),
      protocolFailure:async()=>{
        const session=current;
        if(!session)throw new Error('MCP Apps verifier session is unavailable');
        session.bridge.sendNotification({
          jsonrpc:'2.0',
          method:'ui/notifications/host-context-changed',
          params:{},
        });
        await waitFor('protocol teardown',()=>protocolTeardown!==undefined);
        return await protocolTeardown;
      },
      receipt:label=>appReceipts.get(label),
      reset:async()=>{
        const previous=await teardown({phase:'loading'});
        const next=await createSession();
        return {current:next,previous};
      },
      restart:async()=>{
        if(current)await teardown({phase:'loading'});
        return await createSession();
      },
      roundTrip:async()=>{
        const session=current;
        if(!session)throw new Error('MCP Apps verifier session is unavailable');
        return await session.bridge.sendRequest({
          id:'round-trip',
          jsonrpc:'2.0',
          method:'ui/resource-teardown',
          params:{},
        });
      },
      shutdown:async()=>{
        const snapshot=await teardown({phase:'cancelled'});
        root.unmount();
        return snapshot;
      },
      snapshot:()=>current?lifecycleSnapshot(current):undefined,
    };
  `;
}

async function buildHarness(directory: string, serverOrigin: string): Promise<string> {
  const appEntryPath = path.join(directory, 'app-entry.js');
  const entryPath = path.join(directory, 'harness-entry.jsx');
  const bundlePath = path.join(directory, 'harness-bundle.js');
  const htmlPath = path.join(directory, 'harness.html');
  await writeFile(appEntryPath, sandboxedAppSource(), 'utf8');
  const appBuild = await build({
    bundle: true,
    entryPoints: [appEntryPath],
    format: 'iife',
    logLevel: 'silent',
    platform: 'browser',
    target: 'chrome136',
    write: false,
  });
  const appBundle = appBuild.outputFiles[0]?.text;
  if (appBundle === undefined) {
    throw new Error('BST-1571 official MCP App bundle is unavailable');
  }
  await writeFile(entryPath, harnessSource(serverOrigin, sandboxedAppDocument(appBundle)), 'utf8');
  await build({
    bundle: true,
    entryPoints: [entryPath],
    format: 'esm',
    loader: {
      '.png': 'dataurl',
      '.svg': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
    },
    logLevel: 'silent',
    outfile: bundlePath,
    platform: 'browser',
    target: 'chrome136',
  });
  await writeFile(
    htmlPath,
    '<!doctype html><html><head><meta charset="utf-8"><title>BST-1571 packaged verifier</title></head><body><main id="root"></main><script type="module" src="./harness-bundle.js"></script></body></html>',
    'utf8'
  );
  return htmlPath;
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof Reflect.get(globalThis, '__bst1571') === 'object');
}

async function harnessCall<T>(page: Page, expression: string): Promise<T> {
  return await page.evaluate((script) => {
    const harness = Reflect.get(globalThis, '__bst1571');
    if (typeof harness !== 'object' || harness === null) {
      throw new Error('BST-1571 harness is unavailable');
    }
    const method = Reflect.get(harness, script);
    if (typeof method !== 'function') {
      throw new Error(`BST-1571 harness method ${script} is unavailable`);
    }
    return Reflect.apply(method, harness, []);
  }, expression);
}

async function harnessCallWithArgs<T>(
  page: Page,
  expression: string,
  args: readonly unknown[]
): Promise<T> {
  return await page.evaluate(
    ({ methodName, values }) => {
      const harness = Reflect.get(globalThis, '__bst1571');
      if (typeof harness !== 'object' || harness === null) {
        throw new Error('BST-1571 harness is unavailable');
      }
      const method = Reflect.get(harness, methodName);
      if (typeof method !== 'function') {
        throw new Error(`BST-1571 harness method ${methodName} is unavailable`);
      }
      return Reflect.apply(method, harness, values);
    },
    { methodName: expression, values: args }
  );
}

async function beginCall(page: Page, label: string, mode = 'success'): Promise<void> {
  await page.evaluate(
    ({ callLabel, callMode }) => {
      const harness = Reflect.get(globalThis, '__bst1571');
      const begin =
        typeof harness === 'object' && harness !== null ? Reflect.get(harness, 'begin') : undefined;
      if (typeof begin !== 'function') {
        throw new Error('BST-1571 harness begin is unavailable');
      }
      Reflect.apply(begin, harness, [callLabel, callMode]);
    },
    { callLabel: label, callMode: mode }
  );
}

async function expectOutcome(page: Page, label: string, outcome: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((callLabel) => {
        const harness = Reflect.get(globalThis, '__bst1571');
        const readOutcome =
          typeof harness === 'object' && harness !== null
            ? Reflect.get(harness, 'outcome')
            : undefined;
        return typeof readOutcome === 'function'
          ? Reflect.apply(readOutcome, harness, [callLabel])
          : undefined;
      }, label)
    )
    .toBe(outcome);
}

async function expectHarnessValue(
  page: Page,
  methodName: string,
  label: string,
  expected: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ callLabel, name }) => {
          const harness = Reflect.get(globalThis, '__bst1571');
          const readValue =
            typeof harness === 'object' && harness !== null
              ? Reflect.get(harness, name)
              : undefined;
          return typeof readValue === 'function'
            ? Reflect.apply(readValue, harness, [callLabel])
            : undefined;
        },
        { callLabel: label, name: methodName }
      )
    )
    .toBe(expected);
}

function expectQuiescent(
  snapshot: LifecycleSnapshot,
  bridgePhase: 'closed' | 'disconnected' = 'closed'
): void {
  expect(snapshot.authority).toEqual({
    listenerCount: 0,
    pendingApprovals: [],
    pendingCalls: 0,
    phase: 'closed',
  });
  expect(snapshot.bridge).toMatchObject({
    listenerCount: 0,
    pendingCallbacks: 0,
    pendingInboundRequests: 0,
    pendingNotifications: 0,
    pendingOutboundRequests: 0,
    phase: bridgePhase,
    timerCount: 0,
  });
  expect(snapshot.resources).toEqual({
    activeFetches: 0,
    activeFrames: 0,
    activeUrls: 0,
    domFrames: 0,
  });
}

async function expectServerIdle(server: LoopbackToolServer): Promise<void> {
  await expect
    .poll(() => {
      const snapshot = server.snapshot();
      return { activeRequests: snapshot.activeRequests, openSockets: snapshot.openSockets };
    })
    .toEqual({ activeRequests: 0, openSockets: 0 });
}

test('MCP Apps production host lifecycle is accessible and quiescent in packaged Electron', {
  tag: ['@destructive', '@packaged'],
}, async () => {
  test.setTimeout(360_000);
  const executablePath = packagedExecutablePath();
  await access(executablePath, constants.X_OK);
  await access(appHostModulePath, constants.R_OK);
  await access(appSurfaceModulePath, constants.R_OK);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-host-'));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-user-data-'));
  const toolServer = await createLoopbackToolServer();
  const harnessPath = await buildHarness(temporaryDirectory, toolServer.origin);
  let packagedApplication: PackagedHarnessApplication | undefined;
  try {
    packagedApplication = await launchPackagedHarness(executablePath, harnessPath, userDataDir);
    const { page } = packagedApplication;
    expect(packagedApplication.isPackaged).toBe(true);
    expect(packagedApplication.sandboxPopupDenied).toBe(true);
    await waitForHarness(page);
    const initial = await harnessCall<LifecycleSnapshot>(page, 'initialReady');
    expect(initial.authority).toMatchObject({ listenerCount: 1, phase: 'open' });
    expect(initial.bridge).toMatchObject({ listenerCount: 1, phase: 'ready', timerCount: 0 });
    expect(initial.resources).toEqual({
      activeFetches: 0,
      activeFrames: 1,
      activeUrls: 1,
      domFrames: 1,
    });

    const completionBefore = toolServer.snapshot();
    await beginCall(page, 'completion');
    const allowButton = page.getByRole('button', { name: 'Allow create_issue once' });
    await expect(allowButton).toBeFocused();
    await expect(page.getByRole('alertdialog')).not.toContainText('must-not-render-in-host-ui');
    await allowButton.click();
    await expectOutcome(page, 'completion', 'resolved');
    await expectHarnessValue(page, 'receipt', 'completion', 'resolved');
    await expect(harnessCall<Readonly<{ released: boolean }>>(page, 'roundTrip')).resolves.toEqual({
      released: true,
    });
    expectQuiescent(await harnessCall(page, 'complete'));
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      completedRequests: completionBefore.completedRequests + 1,
      totalRequests: completionBefore.totalRequests + 1,
    });
    await expect(page.getByRole('status')).toHaveText('Linear issue editor completed.');
    await expect(page.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();

    await harnessCall(page, 'restart');
    const denialBefore = toolServer.snapshot();
    await beginCall(page, 'denial');
    await page.getByRole('button', { name: 'Deny create_issue' }).click();
    await expectOutcome(page, 'denial', 'rejected');
    await expectHarnessValue(page, 'receipt', 'denial', 'rejected');
    await expect(page.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();
    expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot().totalRequests).toBe(denialBefore.totalRequests);

    await harnessCall(page, 'restart');
    const failureBefore = toolServer.snapshot();
    await beginCall(page, 'failure', 'failure');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expectOutcome(page, 'failure', 'rejected');
    await expectHarnessValue(page, 'receipt', 'failure', 'rejected');
    expectQuiescent(await harnessCall(page, 'fail'));
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      completedRequests: failureBefore.completedRequests + 1,
      totalRequests: failureBefore.totalRequests + 1,
    });
    await expect(page.getByRole('alert')).toContainText('The app could not start safely.');
    await expect(page.getByRole('button', { name: 'Retry Linear issue editor' })).toBeFocused();

    await harnessCall(page, 'restart');
    const replacementBefore = toolServer.snapshot();
    await beginCall(page, 'replacement', 'hold');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
    await harnessCallWithArgs(page, 'beginPendingRpc', ['replacement']);
    const replacement = await harnessCall<{
      readonly current: LifecycleSnapshot;
      readonly previous: LifecycleSnapshot;
    }>(page, 'reset');
    expectQuiescent(replacement.previous);
    expect(replacement.current.authority).toMatchObject({ listenerCount: 1, phase: 'open' });
    expect(replacement.current.bridge).toMatchObject({ listenerCount: 1, phase: 'ready' });
    expect(replacement.current.resources).toEqual({
      activeFetches: 0,
      activeFrames: 1,
      activeUrls: 1,
      domFrames: 1,
    });
    await expectHarnessValue(page, 'pendingRpcOutcome', 'replacement', 'rejected');
    expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      abortedRequests: replacementBefore.abortedRequests + 1,
      totalRequests: replacementBefore.totalRequests + 1,
    });

    await harnessCall(page, 'restart');
    const disconnectBefore = toolServer.snapshot();
    await beginCall(page, 'disconnect', 'hold');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
    expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
    await expectOutcome(page, 'disconnect', 'rejected');
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      abortedRequests: disconnectBefore.abortedRequests + 1,
      totalRequests: disconnectBefore.totalRequests + 1,
    });

    await harnessCall(page, 'restart');
    const timeoutBefore = toolServer.snapshot();
    await beginCall(page, 'timeout', 'hold');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
    await expectOutcome(page, 'timeout', 'rejected');
    await expectHarnessValue(page, 'receipt', 'timeout', 'rejected');
    await expectServerIdle(toolServer);
    const afterTimeout = await harnessCall<LifecycleSnapshot>(page, 'snapshot');
    expect(afterTimeout.authority).toMatchObject({ pendingCalls: 0, phase: 'open' });
    expect(afterTimeout.bridge).toMatchObject({
      listenerCount: 1,
      pendingCallbacks: 0,
      pendingInboundRequests: 0,
      pendingOutboundRequests: 0,
      phase: 'ready',
      timerCount: 0,
    });
    expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
    expect(toolServer.snapshot()).toMatchObject({
      abortedRequests: timeoutBefore.abortedRequests + 1,
      totalRequests: timeoutBefore.totalRequests + 1,
    });

    await harnessCall(page, 'restart');
    const protocolBefore = toolServer.snapshot();
    await beginCall(page, 'protocol', 'hold');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
    const protocolFailure = await harnessCall<LifecycleSnapshot>(page, 'protocolFailure');
    expectQuiescent(protocolFailure, 'disconnected');
    await expectOutcome(page, 'protocol', 'rejected');
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      abortedRequests: protocolBefore.abortedRequests + 1,
      totalRequests: protocolBefore.totalRequests + 1,
    });

    await harnessCall(page, 'restart');
    const shutdownBefore = toolServer.snapshot();
    await beginCall(page, 'shutdown', 'hold');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
    expectQuiescent(await harnessCall(page, 'shutdown'));
    await expectOutcome(page, 'shutdown', 'rejected');
    await expectServerIdle(toolServer);
    expect(toolServer.snapshot()).toMatchObject({
      abortedRequests: shutdownBefore.abortedRequests + 1,
      totalRequests: shutdownBefore.totalRequests + 1,
    });

    expect(await packagedApplication.closeSandbox()).toBe(true);
    await page.close();

    const launchedBrowser = packagedApplication.browser;
    expect(packagedApplication.child.kill('SIGTERM')).toBe(true);
    await waitForProcessExit(packagedApplication.child);
    await expect.poll(() => launchedBrowser.isConnected()).toBe(false);
    packagedApplication = undefined;
    await expectServerIdle(toolServer);
    await toolServer.close();
    expect(toolServer.snapshot()).toMatchObject({
      activeRequests: 0,
      listening: false,
      openSockets: 0,
    });
  } finally {
    if (packagedApplication) {
      await packagedApplication.closeSandbox().catch(() => false);
      packagedApplication.child.kill('SIGTERM');
      await waitForProcessExit(packagedApplication.child).catch(() => {
        packagedApplication?.child.kill('SIGKILL');
      });
      await packagedApplication.browser.close().catch(() => undefined);
    }
    await toolServer.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});
