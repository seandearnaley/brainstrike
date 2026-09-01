import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';

const appHostModulePath = path.resolve(process.cwd(), '../../packages/mcp-app-host/dist/index.js');
const appSurfaceModulePath = path.resolve(
  process.cwd(),
  '../../packages/assistant-ui/dist/mcp-app-host-surface.js'
);
const requireFromTest = createRequire(import.meta.url);
const reactModulePath = requireFromTest.resolve('react');
const reactDomClientModulePath = requireFromTest.resolve('react-dom/client');

interface AuthoritySnapshot {
  readonly listenerCount: number;
  readonly pendingApprovals: readonly unknown[];
  readonly pendingCalls: number;
  readonly phase: 'closed' | 'open';
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

function harnessSource(): string {
  return `
    import React, {createRef} from ${JSON.stringify(reactModulePath)};
    import {createRoot} from ${JSON.stringify(reactDomClientModulePath)};
    import {McpAppHostSurface} from ${JSON.stringify(appSurfaceModulePath)};
    import {McpAppProvenanceAuthority, McpAppToolCallAuthority} from ${JSON.stringify(appHostModulePath)};

    const APP_NAME='Linear issue editor';
    const outcomes=new Map();
    const recoveryFocusRef=createRef();
    let authority;
    let executionMode='success';
    let root=createRoot(document.getElementById('root'));

    function createAuthority(){
      const provenance=new McpAppProvenanceAuthority();
      const generation=provenance.openGeneration({generation:1,serverId:'linear'});
      provenance.registerTool(generation,{_meta:{ui:{visibility:['app']}},name:'create_issue'});
      authority=new McpAppToolCallAuthority({
        generation,
        prepare:async()=>({
          decision:'ask',
          execute:async({signal})=>{
            if(signal.aborted)throw signal.reason;
            if(executionMode==='failure')throw new Error('private failure detail');
            return {content:[]};
          },
          riskCategory:'execute',
        }),
        provenance,
      });
    }

    function render(state){
      root.render(React.createElement(
        React.Fragment,
        null,
        React.createElement('button',{id:'recovery',ref:recoveryFocusRef,'aria-label':'Return to Linear result',type:'button'},'Return'),
        React.createElement(
          McpAppHostSurface,
          {
            appName:APP_NAME,
            authority,
            onCancel:()=>globalThis.__bst1571.disconnect(),
            onRetry:()=>globalThis.__bst1571.reset(),
            recoveryFocusRef,
            state,
          },
          React.createElement('div',{'aria-label':'Sandboxed Linear app',role:'application'},'Sandboxed app')
        )
      ));
    }

    function begin(label,mode='success'){
      executionMode=mode;
      outcomes.set(label,'pending');
      const call=authority.call({
        arguments:{secret:'must-not-render-in-host-ui'},
        id:label,
        name:'create_issue',
      });
      call.then(()=>outcomes.set(label,'resolved'),()=>outcomes.set(label,'rejected'));
    }

    async function closeAndRender(state){
      const snapshot=await authority.close();
      render(state);
      return snapshot;
    }

    createAuthority();
    render({phase:'ready'});
    globalThis.__bst1571={
      begin,
      complete:()=>closeAndRender({phase:'completed'}),
      disconnect:()=>closeAndRender({phase:'cancelled'}),
      fail:()=>closeAndRender({code:'protocol-failed',phase:'error'}),
      outcome:label=>outcomes.get(label),
      reset:async()=>{
        const previous=authority;
        const previousSnapshot=await previous.close();
        createAuthority();
        render({phase:'ready'});
        return {current:authority.snapshot,previous:previousSnapshot};
      },
      shutdown:async()=>{
        root.unmount();
        return await authority.close();
      },
      snapshot:()=>authority.snapshot,
      tabClose:()=>authority.close(),
    };
  `;
}

async function buildHarness(directory: string): Promise<string> {
  const entryPath = path.join(directory, 'harness-entry.jsx');
  const bundlePath = path.join(directory, 'harness-bundle.js');
  const htmlPath = path.join(directory, 'harness.html');
  await writeFile(entryPath, harnessSource(), 'utf8');
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

function expectQuiescent(snapshot: AuthoritySnapshot): void {
  expect(snapshot).toEqual({
    listenerCount: 0,
    pendingApprovals: [],
    pendingCalls: 0,
    phase: 'closed',
  });
}

test('MCP Apps production host lifecycle is accessible and quiescent in packaged Electron', async () => {
  test.setTimeout(240_000);
  const executablePath = packagedExecutablePath();
  await access(executablePath, constants.X_OK);
  await access(appHostModulePath, constants.R_OK);
  await access(appSurfaceModulePath, constants.R_OK);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-host-'));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1571-packaged-user-data-'));
  const harnessPath = await buildHarness(temporaryDirectory);
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
    expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true);

    const windowPromise = electronApp.waitForEvent('window');
    await electronApp.evaluate(async ({ BrowserWindow }, filePath) => {
      const window = new BrowserWindow({
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition: `bst-1571-packaged-host-${process.pid}`,
          sandbox: true,
          webSecurity: true,
        },
      });
      let cleanupComplete = false;
      window.on('close', (event) => {
        if (cleanupComplete) {
          return;
        }
        event.preventDefault();
        void window.webContents
          .executeJavaScript('globalThis.__bst1571.tabClose()')
          .then((snapshot) => {
            Reflect.set(globalThis, '__bst1571TabCloseResult', { snapshot });
          })
          .catch((error: unknown) => {
            Reflect.set(globalThis, '__bst1571TabCloseResult', {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            cleanupComplete = true;
            window.close();
          });
      });
      await window.loadFile(filePath);
    }, harnessPath);
    const page = await windowPromise;
    await waitForHarness(page);

    await beginCall(page, 'completion');
    const allowButton = page.getByRole('button', { name: 'Allow create_issue once' });
    await expect(allowButton).toBeFocused();
    await expect(page.getByRole('alertdialog')).not.toContainText('must-not-render-in-host-ui');
    await allowButton.click();
    await expectOutcome(page, 'completion', 'resolved');
    expectQuiescent(await harnessCall(page, 'complete'));
    await expect(page.getByRole('status')).toHaveText('Linear issue editor completed.');
    await expect(page.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();

    await page.reload();
    await waitForHarness(page);
    await beginCall(page, 'denial');
    await page.getByRole('button', { name: 'Deny create_issue' }).click();
    await expectOutcome(page, 'denial', 'rejected');
    await expect(page.getByRole('button', { name: 'Return to Linear result' })).toBeFocused();
    expectQuiescent(await harnessCall(page, 'disconnect'));

    await page.reload();
    await waitForHarness(page);
    await beginCall(page, 'failure', 'failure');
    await page.getByRole('button', { name: 'Allow create_issue once' }).click();
    await expectOutcome(page, 'failure', 'rejected');
    expectQuiescent(await harnessCall(page, 'fail'));
    await expect(page.getByRole('alert')).toContainText('The app could not start safely.');
    await expect(page.getByRole('button', { name: 'Retry Linear issue editor' })).toBeFocused();

    await page.reload();
    await waitForHarness(page);
    await beginCall(page, 'replacement');
    const replacement = await harnessCall<{
      readonly current: AuthoritySnapshot;
      readonly previous: AuthoritySnapshot;
    }>(page, 'reset');
    expectQuiescent(replacement.previous);
    expect(replacement.current).toMatchObject({ listenerCount: 0, phase: 'open' });
    await expect
      .poll(() => harnessCall<AuthoritySnapshot>(page, 'snapshot'))
      .toMatchObject({
        listenerCount: 1,
        pendingApprovals: [],
        pendingCalls: 0,
        phase: 'open',
      });
    expectQuiescent(await harnessCall(page, 'disconnect'));

    await page.reload();
    await waitForHarness(page);
    await beginCall(page, 'shutdown');
    expectQuiescent(await harnessCall(page, 'shutdown'));

    await page.reload();
    await waitForHarness(page);
    await beginCall(page, 'tab-close');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await electronApp.evaluate(({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('bst-1571-packaged-host-')
      );
      if (!hostWindow) {
        throw new Error('BST-1571 packaged host window is unavailable');
      }
      hostWindow.close();
    });
    await expect.poll(() => page.isClosed()).toBe(true);
    await expect
      .poll(() => electronApp?.evaluate(() => Reflect.get(globalThis, '__bst1571TabCloseResult')))
      .toMatchObject({ snapshot: { phase: 'closed' } });
    const tabCloseResult = await electronApp.evaluate(() =>
      Reflect.get(globalThis, '__bst1571TabCloseResult')
    );
    expectQuiescent(
      (tabCloseResult as unknown as { readonly snapshot: AuthoritySnapshot }).snapshot
    );
  } finally {
    await electronApp?.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});
