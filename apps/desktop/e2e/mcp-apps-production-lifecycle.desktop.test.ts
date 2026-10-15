import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { type Browser, chromium, type Page } from 'playwright';
import { APP_RENDERER_DOCUMENT_URL } from '../src/desktop-renderer-origin';
import {
  createLoopbackToolServer,
  type LoopbackToolServer,
} from './helpers/mcp-apps-loopback-tool-server';
import { installOrdinaryRuntimeAdmission } from './helpers/mcp-apps-ordinary-admission';

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
  readonly activeShells: number;
  readonly domFrames: number;
}

/** What the host window's own CSP did to a blob: frame (the pre-fix shell transport). */
interface HostCspProbe {
  readonly blockedUri: string;
  readonly hasMetaCsp: boolean;
  readonly violatedDirective: string;
}

/** Whether the shell and app frames survived navigation attempts from the host. */
interface FrameFenceProbe {
  readonly appFrames: number;
  readonly roundTrip: unknown;
  readonly shellDocumentReachable: boolean;
}

/** One `will-download` the main process saw while the probe ran. */
interface RecordedDownload {
  /** True when the session policy already cancelled it before the recorder ran. */
  readonly defaultPrevented: boolean;
  readonly url: string;
}

/**
 * What the main window's session policy did to the mounted MCP App sandbox
 * (BST-1599). `notifications` is deliberate: it is NOT a Permissions-Policy
 * feature, so the app frame's `allow` attribute and the shell's
 * `Permissions-Policy` header cannot touch it — without a session handler
 * Electron's default GRANTS it to the opaque app document.
 */
interface SandboxSessionPolicyProbe {
  readonly appPermission: string;
  /** `Notification.permission` + `navigator.permissions.query`, `/`-joined. */
  readonly appPermissionState: string;
  readonly downloads: readonly RecordedDownload[];
  readonly hostPermission: string;
  readonly hostPermissionState: string;
  readonly shellPermission: string;
  readonly shellPermissionState: string;
}

interface PackagedHarnessApplication {
  readonly browser: Browser;
  readonly child: ChildProcessWithoutNullStreams;
  /** Evaluates an expression in the packaged MAIN process. */
  readonly evaluateInMain: (expression: string) => Promise<unknown>;
  /** Fetches a URL from the packaged MAIN process (custom schemes included). */
  readonly fetchStatusFromMain: (url: string) => Promise<number>;
  readonly isPackaged: boolean;
  readonly page: Page;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LifecycleSnapshot {
  readonly authority: AuthoritySnapshot;
  readonly bridge: BridgeSnapshot;
  readonly resources: ResourceSnapshot;
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
        async result=>{
          pending.delete(label);
          const outcome=result?.isError===true?'rejected':'resolved';
          await app.sendLog({data:{callId:label,outcome},level:'info'});
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

const RENDERER_PAGE_URL = APP_RENDERER_DOCUMENT_URL;

/**
 * Launches the packaged app and attaches to its REAL main window (default
 * session, production preload, the production CSP stamped by setup-security
 * on the bundled renderer origin) instead of a harness window on a private
 * partition: the earlier harness partition escaped the header stamp and hid
 * a `frame-src` regression that blocked the app shell in production.
 */
async function launchPackagedHarness(
  executablePath: string,
  harnessBundle: string,
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
      `(async()=>{const requireFromMain=process.getBuiltinModule('node:module').createRequire(process.execPath);const{app}=requireFromMain('electron');await app.whenReady();return{isPackaged:app.isPackaged}})()`
    );
    if (!isRecord(launchResult) || typeof launchResult['isPackaged'] !== 'boolean') {
      throw new Error('BST-1571 packaged launch result is malformed');
    }
    const fetchStatusFromMain = async (url: string): Promise<number> => {
      const status = await evaluateElectronMain(
        endpoints.main,
        `(async()=>{const requireFromMain=process.getBuiltinModule('node:module').createRequire(process.execPath);const{net}=requireFromMain('electron');const response=await net.fetch(${JSON.stringify(url)});return{status:response.status}})()`
      );
      if (!isRecord(status) || typeof status['status'] !== 'number') {
        throw new Error('BST-1571 main-process fetch result is malformed');
      }
      return status['status'];
    };
    const browser = await chromium.connectOverCDP(endpoints.browser);
    let page: Page | undefined;
    await expect
      .poll(
        () => {
          page = browser
            .contexts()[0]
            ?.pages()
            .find((candidate) => candidate.url() === RENDERER_PAGE_URL);
          return page?.url() === RENDERER_PAGE_URL;
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    if (!page) {
      throw new Error('BST-1571 packaged renderer page is unavailable');
    }
    // The production preload must have exposed the Apps bridge before the
    // harness (which mounts through it) is injected.
    await page.waitForFunction(
      () => typeof Reflect.get(Reflect.get(globalThis, 'mcp') ?? {}, 'apps') === 'object',
      undefined,
      { timeout: 60_000 }
    );
    // Injected as a blob: script, which the production `script-src` admits.
    // NOT over CDP `Runtime.evaluate`: DevTools-evaluated code is exempt from
    // CSP eval checks, so zod's cached `new Function` probe would succeed at
    // module init and every later message parse would throw EvalError from an
    // ordinary event callback — a harness artifact production never sees.
    await page.evaluate(async (source) => {
      const errors: string[] = [];
      Reflect.set(globalThis, '__bst1571LoadErrors', errors);
      window.addEventListener('error', (event) => {
        errors.push(String(event.error instanceof Error ? event.error.stack : event.message));
      });
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = url;
          script.addEventListener('load', () => resolve(), { once: true });
          script.addEventListener(
            'error',
            () => reject(new Error('BST-1571 harness script failed to load')),
            { once: true }
          );
          document.head.append(script);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }, harnessBundle);
    return {
      browser,
      child,
      evaluateInMain: async (expression: string) =>
        await evaluateElectronMain(endpoints.main, expression),
      fetchStatusFromMain,
      isPackaged: launchResult['isPackaged'],
      page,
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
    const apps=globalThis.mcp?.apps;
    if(typeof apps?.prepareShell!=='function'||typeof apps?.releaseShell!=='function'){
      throw new Error('BST-1571 production Apps bridge is unavailable on window.mcp.apps');
    }
    const activeShells=new Set();
    const appReceipts=new Map();
    const outcomes=new Map();
    const callFailures=new Map();
    const pendingRpcOutcomes=new Map();
    const prepareCancellations=new Map();
    const protocolErrors=[];
    const protocolDiagnostics=[];
    const frameBindings=[];
    const provenance=new McpAppProvenanceAuthority();
    const recoveryFocusRef=createRef();
    const sandboxFrameRef=createRef();
    // Shells are served by the packaged main process on brainstrike-mcp-app:
    // through the PRODUCTION preload bridge; nothing here mints a URL.
    const sandboxOwner=new McpAppSandboxOwner({
      shellHost:{
        async prepareShell(shell){
          const lease=await apps.prepareShell(shell);
          activeShells.add(lease.token);
          return lease;
        },
        async releaseShell(lease){
          await apps.releaseShell(lease);
          activeShells.delete(lease.token);
        },
      },
    });
    let activeFetches=0;
    let current;
    let generationSequence=0;
    let lastAuthority;
    let protocolTeardown;
    const container=document.createElement('div');
    container.id='bst-1571-root';
    document.body.append(container);
    let root=createRoot(container);

    const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

    async function waitFor(label,predicate,timeoutMs=5000){
      const deadline=performance.now()+timeoutMs;
      while(!predicate()){
        if(performance.now()>deadline){
          throw new Error(label+' timeout: '+JSON.stringify({
            bridge:current?.bridge.snapshot,
            protocolErrors,
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
        activeShells:activeShells.size,
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

    async function requestAdmission(path,payload,signal){
      activeFetches+=1;
      try{
        const response=await fetch(SERVER_ORIGIN+path,{
          body:JSON.stringify(payload),
          method:'POST',
          signal,
        });
        if(!response.ok)throw new Error('MCP Apps ordinary admission request failed');
        return await response.json();
      }finally{
        activeFetches-=1;
      }
    }

    async function prepareOrdinaryCall(call,context){
      const prepared=await requestAdmission(
        '/prepare',
        {call,preparationId:context.id},
        context.signal
      );
      if(
        !prepared||typeof prepared!=='object'||
        (prepared.decision!=='allow'&&prepared.decision!=='ask')||
        typeof prepared.riskCategory!=='string'||
        prepared.token!==context.id
      )throw new Error('MCP Apps ordinary admission response is invalid');
      return {
        decision:prepared.decision,
        execute:async({signal})=>await requestAdmission('/execute',{token:prepared.token},signal),
        riskCategory:prepared.riskCategory,
      };
    }

    async function releaseOrdinaryCall(_call,context){
      await requestAdmission('/release',{preparationId:context.id});
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
      const mount=await sandboxOwner.open(resource);
      const authority=new McpAppToolCallAuthority({
        generation,
        prepare:prepareOrdinaryCall,
        provenance,
        release:releaseOrdinaryCall,
      });
      lastAuthority=authority;
      render({phase:'ready'},authority,mount.shellUrl);
      await waitFor('sandbox shell frame',()=>sandboxFrameRef.current?.contentWindow);
      const outerFrame=sandboxFrameRef.current;
      frameBindings.push({
        expectedShellUrl:mount.shellUrl,
        frameConnected:outerFrame.isConnected,
        frameUrl:outerFrame.src,
        generation:generation.generation,
      });
      // The shell is cross-origin (its own brainstrike-mcp-app: origin): its
      // document is unreachable and the app frame is its first child window.
      await waitFor('sandbox app frame',()=>outerFrame.contentWindow?.length===1);
      const appWindow=outerFrame.contentWindow[0];
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
          protocolErrors.push(String(error.stack??error.message).slice(0,1500));
          protocolDiagnostics.push({bridge:bridge.snapshot,message:String(error.message)});
          // Source/origin diagnostics reject foreign traffic while retaining
          // the bound frame. Only the canonical disconnected phase is fatal.
          if(current?.bridge===bridge&&bridge.snapshot.phase==='disconnected'&&!current.tearingDown){
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
            outcomes.set(label,result?.isError===true?'rejected':'resolved');
            return result;
          }catch(error){
            callFailures.set(label,String(error.stack??error.message??error));
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
      await requestAdmission('/release',{generation:session.generation.generation});
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

    function beginPrepareCancellation(label){
      const session=current;
      if(!session)throw new Error('MCP Apps verifier session is unavailable');
      if(prepareCancellations.has(label))throw new Error('MCP Apps verifier cancellation label is duplicated');
      const controller=new AbortController();
      prepareCancellations.set(label,controller);
      outcomes.set(label,'pending');
      void session.authority.call({
        arguments:{label,mode:'hold-prepare-response'},
        id:'prepare-cancel-'+label,
        name:'create_issue',
      },{signal:controller.signal}).then(
        ()=>outcomes.set(label,'resolved'),
        error=>{
          callFailures.set(label,String(error.stack??error.message??error));
          outcomes.set(label,'rejected');
        }
      ).finally(()=>prepareCancellations.delete(label));
    }

    function cancelPrepare(label){
      const controller=prepareCancellations.get(label);
      if(!controller)throw new Error('MCP Apps verifier prepare cancellation is unavailable');
      controller.abort(new Error('BST-1571 prepare response cancelled'));
    }

    async function probeHostCsp(){
      // A blob: shell was the pre-fix transport; the production stamp must
      // block it as a frame source, and that stamp must be a HEADER (the
      // renderer document carries no meta policy).
      const hasMetaCsp=document.querySelector('meta[http-equiv="Content-Security-Policy" i]')!==null;
      const violation=new Promise(resolve=>{
        const onViolation=event=>{
          if(event.violatedDirective==='frame-src'){
            document.removeEventListener('securitypolicyviolation',onViolation);
            resolve({blockedUri:event.blockedURI,hasMetaCsp,violatedDirective:event.violatedDirective});
          }
        };
        document.addEventListener('securitypolicyviolation',onViolation);
      });
      const url=URL.createObjectURL(new Blob(['<!doctype html><title>blob shell</title>'],{type:'text/html'}));
      const frame=document.createElement('iframe');
      frame.src=url;
      container.append(frame);
      try{
        return await Promise.race([
          violation,
          new Promise((_,reject)=>setTimeout(()=>reject(new Error('host CSP never reported a frame-src violation for blob:')),5000)),
        ]);
      }finally{
        frame.remove();
        URL.revokeObjectURL(url);
      }
    }

    async function probeFrameFence(){
      const session=current;
      if(!session)throw new Error('MCP Apps verifier session is unavailable');
      const shell=session.outerFrame.contentWindow;
      // Cross-origin location assignment is permitted by the platform, and
      // the host CSP admits brainstrike-canvas: as a frame source, so ONLY
      // the main window's will-frame-navigate fence keeps the shell (and the
      // app inside it) alive here. (about:blank would not prove anything: it
      // commits in the renderer without a browser-side navigation.)
      shell.location.href='brainstrike-canvas://shell/';
      await delay(750);
      const roundTrip=await session.bridge.sendRequest({
        id:'fence-round-trip',
        jsonrpc:'2.0',
        method:'ui/resource-teardown',
        params:{},
      });
      return {
        appFrames:session.outerFrame.contentWindow.length,
        roundTrip,
        shellDocumentReachable:session.outerFrame.contentDocument!==null,
      };
    }

    const initialReady=createSession();
    globalThis.__bst1571={
      probeFrameFence,
      probeHostCsp,
      shellUrl:()=>current?.mount.shellUrl,
      begin,
      beginPrepareCancellation,
      beginPendingRpc,
      cancelPrepare,
      complete:()=>teardown({phase:'completed'}),
      disconnect:()=>teardown({phase:'cancelled'},'disconnect'),
      fail:()=>teardown({code:'protocol-failed',phase:'error'}),
      initialReady:()=>initialReady,
      outcome:label=>outcomes.get(label),
      diagnostics:()=>({
        callFailures:Object.fromEntries(callFailures),
        frameBindings:[...frameBindings],
        outcomes:Object.fromEntries(outcomes),
        protocolDiagnostics:[...protocolDiagnostics],
        protocolErrors:[...protocolErrors],
        snapshot:current?lifecycleSnapshot(current):undefined,
      }),
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
  // One self-contained IIFE, injected into the packaged renderer over CDP.
  const harnessBuild = await build({
    bundle: true,
    entryPoints: [entryPath],
    format: 'iife',
    loader: {
      '.png': 'dataurl',
      '.svg': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
    },
    logLevel: 'silent',
    platform: 'browser',
    target: 'chrome136',
    write: false,
  });
  const harnessBundle = harnessBuild.outputFiles[0]?.text;
  if (harnessBundle === undefined) {
    throw new Error('BST-1571 harness bundle is unavailable');
  }
  return harnessBundle;
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const errors = Reflect.get(globalThis, '__bst1571LoadErrors');
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`BST-1571 harness failed to load: ${errors.join('\n')}`);
    }
    return typeof Reflect.get(globalThis, '__bst1571') === 'object';
  });
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
    activeShells: 0,
    domFrames: 0,
  });
}

/**
 * Drives the MOUNTED sandbox from the packaged main process and reports what
 * the session policy did (BST-1599). Runs in main because Electron reports no
 * frame for `will-download` and no origin for the opaque app document: the
 * probe reaches each frame through `webFrameMain` and watches the real
 * `session.defaultSession` events.
 */
async function probeSandboxSessionPolicy(
  application: PackagedHarnessApplication
): Promise<SandboxSessionPolicyProbe> {
  const askPermission = `(typeof Notification==='undefined'?Promise.resolve('unavailable'):Notification.requestPermission().then(function(v){return v},function(e){return 'ERR:'+e.message}))`;
  // The CHECK path, which no request ever reaches: `Notification.permission`
  // and `navigator.permissions.query` are answered by
  // `setPermissionCheckHandler` alone. Read BEFORE any request so the host's
  // own grant cannot mask what the check reported.
  const readPermissionState = `(async()=>{
    if(typeof Notification==='undefined')return 'unavailable';
    let queried='no-permissions-api';
    if(navigator.permissions&&navigator.permissions.query){
      queried=await navigator.permissions.query({name:'notifications'}).then(function(s){return s.state},function(e){return 'ERR:'+e.message});
    }
    return Notification.permission+'/'+queried;
  })()`;
  const startDownload = `(function(){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['bst-1599'],{type:'application/octet-stream'}));a.download='bst-1599.bin';document.body.append(a);a.click();return 'clicked'})()`;
  const probe = await application.evaluateInMain(`(async()=>{
    const requireFromMain=process.getBuiltinModule('node:module').createRequire(process.execPath);
    const{BrowserWindow,session}=requireFromMain('electron');
    const win=BrowserWindow.getAllWindows().find(candidate=>candidate.webContents.getURL()===${JSON.stringify(RENDERER_PAGE_URL)});
    if(!win)throw new Error('BST-1599 main window is unavailable');
    const frames=win.webContents.mainFrame.framesInSubtree;
    const shell=frames.find(frame=>frame.url.startsWith('brainstrike-mcp-app://'));
    const appFrame=frames.find(frame=>frame.url==='about:srcdoc'&&frame.parent&&frame.parent.url.startsWith('brainstrike-mcp-app://'));
    if(!(shell&&appFrame))throw new Error('BST-1599 MCP App sandbox frames are not mounted');
    const downloads=[];
    const record=(event,item)=>{
      downloads.push({defaultPrevented:event.defaultPrevented,url:item.getURL()});
      if(!event.defaultPrevented)event.preventDefault();
    };
    session.defaultSession.on('will-download',record);
    try{
      const appPermissionState=await appFrame.executeJavaScript(${JSON.stringify(readPermissionState)},true);
      const shellPermissionState=await shell.executeJavaScript(${JSON.stringify(readPermissionState)},true);
      const hostPermissionState=await win.webContents.mainFrame.executeJavaScript(${JSON.stringify(readPermissionState)},true);
      const appPermission=await appFrame.executeJavaScript(${JSON.stringify(askPermission)},true);
      const shellPermission=await shell.executeJavaScript(${JSON.stringify(askPermission)},true);
      const hostPermission=await win.webContents.mainFrame.executeJavaScript(${JSON.stringify(askPermission)},true);
      // The app frame's download is started FIRST, so if the sandbox ever
      // admitted one it reaches 'will-download' before the two that must
      // arrive. Poll for those two rather than sleeping a fixed span: a
      // loaded runner must not be able to turn a real pass red, and a
      // regression that merely DELAYS a download must not read as "no
      // download". The short settle afterwards covers a reordering.
      await appFrame.executeJavaScript(${JSON.stringify(startDownload)},true);
      await shell.executeJavaScript(${JSON.stringify(startDownload)},true);
      await win.webContents.mainFrame.executeJavaScript(${JSON.stringify(startDownload)},true);
      const deadline=Date.now()+30000;
      while(downloads.length<2&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      await new Promise(resolve=>setTimeout(resolve,250));
      return{appPermission,appPermissionState,downloads,hostPermission,hostPermissionState,shellPermission,shellPermissionState};
    }finally{
      session.defaultSession.off('will-download',record);
    }
  })()`);
  if (
    !isRecord(probe) ||
    typeof probe['appPermission'] !== 'string' ||
    typeof probe['appPermissionState'] !== 'string' ||
    typeof probe['hostPermission'] !== 'string' ||
    typeof probe['hostPermissionState'] !== 'string' ||
    typeof probe['shellPermission'] !== 'string' ||
    typeof probe['shellPermissionState'] !== 'string' ||
    !Array.isArray(probe['downloads'])
  ) {
    throw new Error(`BST-1599 sandbox session policy probe is malformed: ${JSON.stringify(probe)}`);
  }
  return probe as unknown as SandboxSessionPolicyProbe;
}

async function expectServerIdle(server: LoopbackToolServer): Promise<void> {
  await expect
    .poll(() => {
      const snapshot = server.snapshot();
      return { activeRequests: snapshot.activeRequests, openSockets: snapshot.openSockets };
    })
    .toEqual({ activeRequests: 0, openSockets: 0 });
}

test(
  'MCP Apps production host lifecycle is accessible and quiescent in packaged Electron',
  {
    tag: ['@destructive', '@packaged'],
  },
  async ({}, testInfo) => {
    test.setTimeout(360_000);
    const executablePath = packagedExecutablePath();
    await access(executablePath, constants.X_OK);
    await access(appHostModulePath, constants.R_OK);
    await access(appSurfaceModulePath, constants.R_OK);
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-host-'));
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-user-data-'));
    const toolServer = await createLoopbackToolServer();
    let disposeAdmission: (() => Promise<void>) | undefined =
      await installOrdinaryRuntimeAdmission(toolServer);
    const harnessBundle = await buildHarness(temporaryDirectory, toolServer.origin);
    let packagedApplication: PackagedHarnessApplication | undefined;
    let rendererDiagnostics: unknown;
    try {
      packagedApplication = await launchPackagedHarness(executablePath, harnessBundle, userDataDir);
      const { page } = packagedApplication;
      const root = page.locator('#bst-1571-root');
      expect(packagedApplication.isPackaged).toBe(true);
      await waitForHarness(page);
      // The REAL main window: its header CSP blocks blob: frames (the pre-fix
      // shell transport that regressed in production) …
      expect(await harnessCall<HostCspProbe>(page, 'probeHostCsp')).toEqual({
        blockedUri: 'blob',
        hasMetaCsp: false,
        violatedDirective: 'frame-src',
      });
      const initial = await harnessCall<LifecycleSnapshot>(page, 'initialReady');
      expect(initial.authority).toMatchObject({ listenerCount: 1, phase: 'open' });
      expect(initial.bridge).toMatchObject({ listenerCount: 1, phase: 'ready', timerCount: 0 });
      expect(initial.resources).toEqual({
        activeFetches: 0,
        activeFrames: 1,
        activeShells: 1,
        domFrames: 1,
      });
      // … while the brainstrike-mcp-app: shell the packaged main serves loaded,
      // handshook through the nested app frame, and is fenced against
      // navigation from the host.
      const shellUrl = await harnessCall<string | undefined>(page, 'shellUrl');
      expect(shellUrl).toMatch(/^brainstrike-mcp-app:\/\/[0-9a-f]{32}\/$/u);
      if (shellUrl === undefined) {
        throw new Error('BST-1571 shell URL is unavailable');
      }
      expect(await packagedApplication.fetchStatusFromMain(shellUrl)).toBe(200);
      expect(await harnessCall<FrameFenceProbe>(page, 'probeFrameFence')).toEqual({
        appFrames: 1,
        roundTrip: { released: true },
        shellDocumentReachable: false,
      });

      // The mounted sandbox shares the main window's session, so the boundary
      // needs a session-level policy too (BST-1599). `notifications` proves it:
      // it is outside Permissions-Policy, so neither the app frame's `allow`
      // attribute nor the shell's header can decline it.
      const sessionPolicy = await probeSandboxSessionPolicy(packagedApplication);
      expect(sessionPolicy.appPermission).toBe('denied');
      expect(sessionPolicy.shellPermission).toBe('denied');
      // The CHECK path is a separate handler with a separate (optional)
      // attribution field, and APIs that check before requesting never reach
      // the request handler — so it is measured against real Electron too, not
      // only against the unit test's hand-rolled session.
      expect(sessionPolicy.appPermissionState).toBe('denied/denied');
      expect(sessionPolicy.shellPermissionState).toBe('denied/denied');
      // …and the host renderer keeps Electron's default outcome on both paths.
      expect(sessionPolicy.hostPermissionState).toBe('granted/granted');
      expect(sessionPolicy.hostPermission).toBe('granted');
      // The app document cannot even reach `will-download`: its sandbox is
      // exactly `allow-scripts`. The shell frame's download DOES reach the
      // session and the policy cancels it, while the host renderer's does not.
      expect(
        sessionPolicy.downloads.filter((download) =>
          download.url.startsWith('blob:brainstrike-mcp-app://')
        )
      ).toEqual([
        {
          defaultPrevented: true,
          url: expect.stringMatching(/^blob:brainstrike-mcp-app:\/\/[0-9a-f]{32}\//u),
        },
      ]);
      expect(
        sessionPolicy.downloads.filter(
          (download) => !download.url.startsWith('blob:brainstrike-mcp-app://')
        )
      ).toEqual([{ defaultPrevented: false, url: expect.stringMatching(/^blob:file:\/\/\//u) }]);

      const completionBefore = toolServer.snapshot();
      await beginCall(page, 'completion');
      const allowButton = root.getByRole('button', { name: 'Allow create_issue once' });
      await expect(allowButton).toBeFocused();
      await expect(root.getByRole('alertdialog')).not.toContainText('must-not-render-in-host-ui');
      await allowButton.click();
      await expectOutcome(page, 'completion', 'resolved');
      await expectHarnessValue(page, 'receipt', 'completion', 'resolved');
      await expect(
        harnessCall<Readonly<{ released: boolean }>>(page, 'roundTrip')
      ).resolves.toEqual({
        released: true,
      });
      expectQuiescent(await harnessCall(page, 'complete'));
      // Release is fenced: the served shell answers 404 the moment the mount closes.
      expect(await packagedApplication.fetchStatusFromMain(shellUrl)).toBe(404);
      await expectServerIdle(toolServer);
      expect(toolServer.snapshot()).toMatchObject({
        completedRequests: completionBefore.completedRequests + 1,
        totalRequests: completionBefore.totalRequests + 1,
      });
      await expect(root.getByRole('status')).toHaveText('Linear issue editor completed.');
      await expect(root.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();

      await harnessCall(page, 'restart');
      const denialBefore = toolServer.snapshot();
      for (const label of ['denial-1', 'denial-2', 'denial-3']) {
        await beginCall(page, label);
        await root.getByRole('button', { name: 'Deny create_issue' }).click();
        await expectOutcome(page, label, 'rejected');
        await expectHarnessValue(page, 'receipt', label, 'rejected');
        await expect.poll(() => toolServer.snapshot().pendingPreparedCalls).toBe(0);
        await expect(root.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();
      }
      expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
      await expectServerIdle(toolServer);
      expect(toolServer.snapshot().totalRequests).toBe(denialBefore.totalRequests);

      await harnessCall(page, 'restart');
      await harnessCallWithArgs(page, 'beginPrepareCancellation', ['prepare-response']);
      await expect.poll(() => toolServer.snapshot().pendingPreparedCalls).toBe(1);
      await harnessCallWithArgs(page, 'cancelPrepare', ['prepare-response']);
      await expectOutcome(page, 'prepare-response', 'rejected');
      await expect.poll(() => toolServer.snapshot().pendingPreparedCalls).toBe(0);
      expectQuiescent(await harnessCall(page, 'disconnect'), 'disconnected');
      await expectServerIdle(toolServer);

      await harnessCall(page, 'restart');
      const failureBefore = toolServer.snapshot();
      await beginCall(page, 'failure', 'failure');
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
      await expectOutcome(page, 'failure', 'rejected');
      await expectHarnessValue(page, 'receipt', 'failure', 'rejected');
      expectQuiescent(await harnessCall(page, 'fail'));
      await expectServerIdle(toolServer);
      expect(toolServer.snapshot()).toMatchObject({
        completedRequests: failureBefore.completedRequests + 1,
        totalRequests: failureBefore.totalRequests + 1,
      });
      await expect(root.getByRole('alert')).toContainText('The app could not start safely.');
      await expect(root.getByRole('button', { name: 'Retry Linear issue editor' })).toBeFocused();

      await harnessCall(page, 'restart');
      const replacementBefore = toolServer.snapshot();
      await beginCall(page, 'replacement', 'hold');
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
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
        activeShells: 1,
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
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
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
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
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
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
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
      await root.getByRole('button', { name: 'Allow create_issue once' }).click();
      await expect.poll(() => toolServer.snapshot().activeRequests).toBe(1);
      expectQuiescent(await harnessCall(page, 'shutdown'));
      await expectOutcome(page, 'shutdown', 'rejected');
      await expectServerIdle(toolServer);
      expect(toolServer.snapshot()).toMatchObject({
        abortedRequests: shutdownBefore.abortedRequests + 1,
        totalRequests: shutdownBefore.totalRequests + 1,
      });

      rendererDiagnostics = await harnessCall<unknown>(page, 'diagnostics');
      const launchedBrowser = packagedApplication.browser;
      expect(packagedApplication.child.kill('SIGTERM')).toBe(true);
      await waitForProcessExit(packagedApplication.child);
      await expect.poll(() => launchedBrowser.isConnected()).toBe(false);
      packagedApplication = undefined;
      await expectServerIdle(toolServer);
      expect(toolServer.snapshot().pendingPreparedCalls).toBe(0);
      await disposeAdmission();
      disposeAdmission = undefined;
      await toolServer.close();
      expect(toolServer.snapshot()).toMatchObject({
        activeRequests: 0,
        listening: false,
        openSockets: 0,
      });
    } finally {
      try {
        const renderer = packagedApplication
          ? await harnessCall<unknown>(packagedApplication.page, 'diagnostics').catch(
              (error: unknown) => ({ unavailable: String(error) })
            )
          : rendererDiagnostics;
        await testInfo.attach('mcp-apps-prepare-diagnostics', {
          body: JSON.stringify(
            {
              failures: toolServer.prepareFailures(),
              prepareRequests: toolServer.prepareRequests(),
              renderer,
              snapshot: toolServer.snapshot(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
      } finally {
        if (packagedApplication) {
          packagedApplication.child.kill('SIGTERM');
          await waitForProcessExit(packagedApplication.child).catch(() => {
            packagedApplication?.child.kill('SIGKILL');
          });
          await packagedApplication.browser.close().catch(() => undefined);
        }
        await disposeAdmission?.().catch(() => undefined);
        await toolServer.close();
        await rm(temporaryDirectory, { force: true, recursive: true });
        await rm(userDataDir, { force: true, recursive: true });
      }
    }
  }
);
