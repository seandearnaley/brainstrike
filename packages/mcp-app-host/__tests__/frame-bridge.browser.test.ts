import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('../src/', import.meta.url)));

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

async function buildOfficialApp(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps');
  const output = await build({
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    stdin: {
      contents: `
        import {App,PostMessageTransport} from ${JSON.stringify(entry)};
        const app=new App({name:document.title,version:'1.0.0'},{},{autoResize:false,strict:true});
        app.ontoolinput=()=>{
          void app.callServerTool({name:'wait'}).catch(error=>console.info('Tool settled',String(error)));
        };
        app.onhostcontextchanged=()=>{
          parent.postMessage({id:'invalid-method',jsonrpc:'2.0',method:'tools/list',params:{}},'*');
        };
        app.onteardown=async(_params,extra)=>{
          if(!(extra.mcpReq.signal instanceof AbortSignal))throw new Error('Missing SDK 2 request signal');
          if(String(extra.mcpReq.id)==='pending')return await new Promise(()=>{});
          return {};
        };
        void app.connect(new PostMessageTransport(parent,parent)).catch(error=>console.error(error));
      `,
      resolveDir: import.meta.dirname,
    },
    target: 'chrome136',
    write: false,
  });
  const script = output.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error('Official SDK 2 app bundle is unavailable');
  }
  return script;
}

function officialAppDocument(label: string, script: string): string {
  return `<!doctype html><title>${label}</title><script>${script.replaceAll('</script>', '<\\/script>')}</script>`;
}

async function createModuleServer(): Promise<{ readonly origin: string; readonly server: Server }> {
  const bundle = await build({
    bundle: true,
    entryPoints: [path.join(SOURCE_ROOT, 'index.ts')],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const moduleText = bundle.outputFiles[0]?.text;
  if (moduleText === undefined) {
    throw new Error('MCP Apps bridge verifier bundle is unavailable');
  }
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>MCP Apps bridge verifier</title>');
        return;
      }
      if (requestUrl.pathname === '/same-origin-frame') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          "<!doctype html><script>parent.postMessage({id:'cross-origin',jsonrpc:'2.0',method:'ping'},'*')</script>"
        );
        return;
      }
      if (requestUrl.pathname !== '/bridge.js') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(moduleText);
    } catch (error: unknown) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'module server failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('MCP Apps bridge verifier server address is unavailable');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

describe('real opaque-origin iframe MCP Apps bridge', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let origin: string;
  let officialApp: string;
  let server: Server;

  beforeAll(async () => {
    ({ origin, server } = await createModuleServer());
    officialApp = await buildOfficialApp();
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    await browser.close();
  });

  async function verifyFrameLifecycle(mode: 'legacy-wire' | 'official-sdk2'): Promise<void> {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.addScriptTag({
      content:
        "import * as bridgeModule from '/bridge.js';globalThis.__mcpAppBridgeModule=bridgeModule;",
      type: 'module',
    });
    await page.waitForFunction(() => Reflect.has(window, '__mcpAppBridgeModule'));
    const result = await page.evaluate(
      async ({ firstHtml, secondHtml, thirdHtml }) => {
        interface BridgeSnapshot {
          readonly listenerCount: number;
          readonly pendingCallbacks: number;
          readonly pendingInboundRequests: number;
          readonly pendingNotifications: number;
          readonly pendingOutboundRequests: number;
          readonly phase: string;
          readonly timerCount: number;
        }
        interface FrameBridge {
          close(): void;
          connect(binding: { generation: number; origin: 'null'; source: Window }): void;
          disconnect(): void;
          replace(binding: { generation: number; origin: 'null'; source: Window }): void;
          sendNotification(message: unknown): void;
          sendRequest(message: unknown): Promise<Readonly<Record<string, unknown>>>;
          readonly snapshot: BridgeSnapshot;
        }
        interface FrameBridgeModule {
          readonly McpAppFrameBridge: new (options: {
            eventTarget: Window;
            isGenerationLive: (generation: number) => boolean;
            onNotification: (message: { method: string }) => void;
            onProtocolError: (error: Error) => void;
            onRequest: (
              message: { method: string; params?: Readonly<Record<string, unknown>> },
              context: { signal: AbortSignal }
            ) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
            timeoutMs: number;
          }) => FrameBridge;
        }
        const bridgeModule = Reflect.get(window, '__mcpAppBridgeModule') as FrameBridgeModule;
        const errors: string[] = [];
        let liveGeneration = 1;
        const bridge = new bridgeModule.McpAppFrameBridge({
          eventTarget: window,
          isGenerationLive: (generation) => generation === liveGeneration,
          onNotification: () => undefined,
          onProtocolError: (error) => errors.push(error.message),
          onRequest: async (message, context) => {
            if (message.method === 'ui/initialize') {
              return {
                hostCapabilities: { serverTools: {} },
                hostContext: { platform: 'desktop' },
                hostInfo: { name: 'Brainstrike', version: '1.0.0' },
                protocolVersion: '2026-01-26',
              };
            }
            if (message.method !== 'tools/call' || message.params?.['name'] !== 'wait') {
              return {};
            }
            return await new Promise((_, reject) => {
              context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                once: true,
              });
            });
          },
          timeoutMs: 1000,
        });
        const waitFor = async (label: string, predicate: () => boolean): Promise<void> => {
          const deadline = performance.now() + 3000;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error(
                `${label} timeout: ${JSON.stringify({ errors, snapshot: bridge.snapshot })}`
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        const createFrame = (): HTMLIFrameElement => {
          const frame = document.createElement('iframe');
          frame.sandbox.add('allow-scripts');
          document.body.append(frame);
          if (frame.contentWindow === null) {
            throw new Error('MCP Apps verifier frame has no contentWindow');
          }
          return frame;
        };

        const first = createFrame();
        const firstSource = first.contentWindow;
        if (firstSource === null) {
          throw new Error('MCP Apps first verifier frame is unavailable');
        }
        bridge.connect({ generation: 1, origin: 'null', source: firstSource });
        first.srcdoc = firstHtml;
        await waitFor('first handshake', () => bridge.snapshot.phase === 'ready');

        const attacker = createFrame();
        attacker.srcdoc =
          "<script>parent.postMessage({id:'attacker',jsonrpc:'2.0',method:'ping'},'*')</script>";
        await waitFor('source rejection', () =>
          errors.some((message) => message.includes('source'))
        );

        bridge.sendNotification({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-input',
          params: {},
        });
        await waitFor('inbound callback', () => bridge.snapshot.pendingInboundRequests === 1);
        const pending = bridge.sendRequest({
          id: 'pending',
          jsonrpc: '2.0',
          method: 'ui/resource-teardown',
          params: {},
        });
        const pendingOutcome = pending.then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : 'rejected')
        );

        liveGeneration = 2;
        const sameOrigin = document.createElement('iframe');
        document.body.append(sameOrigin);
        const sameOriginSource = sameOrigin.contentWindow;
        if (sameOriginSource === null) {
          throw new Error('MCP Apps same-origin verifier frame is unavailable');
        }
        bridge.replace({ generation: 2, origin: 'null', source: sameOriginSource });
        const afterReplacement = bridge.snapshot;
        sameOrigin.src = '/same-origin-frame';
        await waitFor('origin rejection', () =>
          errors.some((message) => message.includes('origin'))
        );

        liveGeneration = 3;
        const second = createFrame();
        const secondSource = second.contentWindow;
        if (secondSource === null) {
          throw new Error('MCP Apps second verifier frame is unavailable');
        }
        bridge.replace({ generation: 3, origin: 'null', source: secondSource });
        second.srcdoc = secondHtml;
        await waitFor('replacement handshake', () => bridge.snapshot.phase === 'ready');
        const pendingError = await pendingOutcome;
        bridge.sendNotification({
          jsonrpc: '2.0',
          method: 'ui/notifications/host-context-changed',
          params: {},
        });
        await waitFor('bound-frame failure', () => bridge.snapshot.phase === 'disconnected');
        const afterFailure = bridge.snapshot;

        liveGeneration = 4;
        const reconnected = createFrame();
        const reconnectedSource = reconnected.contentWindow;
        if (reconnectedSource === null) {
          throw new Error('MCP Apps reconnected verifier frame is unavailable');
        }
        bridge.connect({ generation: 4, origin: 'null', source: reconnectedSource });
        reconnected.srcdoc = secondHtml;
        await waitFor('reconnect handshake', () => bridge.snapshot.phase === 'ready');
        bridge.disconnect();
        const afterDisconnect = bridge.snapshot;

        liveGeneration = 5;
        const third = createFrame();
        const thirdSource = third.contentWindow;
        if (thirdSource === null) {
          throw new Error('MCP Apps third verifier frame is unavailable');
        }
        bridge.connect({ generation: 5, origin: 'null', source: thirdSource });
        third.srcdoc = thirdHtml;
        await waitFor('final handshake', () => bridge.snapshot.phase === 'ready');
        bridge.close();
        return {
          afterClose: bridge.snapshot,
          afterDisconnect,
          afterFailure,
          afterReplacement,
          errors,
          pendingError,
        };
      },
      {
        firstHtml:
          mode === 'legacy-wire' ? appDocument('first') : officialAppDocument('first', officialApp),
        secondHtml:
          mode === 'legacy-wire'
            ? appDocument('second')
            : officialAppDocument('second', officialApp),
        thirdHtml:
          mode === 'legacy-wire' ? appDocument('third') : officialAppDocument('third', officialApp),
      }
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        'MCP Apps message source does not match the connected frame',
        'MCP Apps message origin does not match the connected frame',
        'MCP Apps message method must be a stable MCP Apps method',
      ])
    );
    expect(result.pendingError).toBe('MCP Apps frame was replaced');
    expect(result.afterReplacement).toMatchObject({
      listenerCount: 1,
      phase: 'awaiting-initialize',
    });
    for (const snapshot of [result.afterReplacement, result.afterFailure, result.afterDisconnect]) {
      expect(snapshot).toMatchObject({
        pendingCallbacks: 0,
        pendingInboundRequests: 0,
        pendingNotifications: 0,
        pendingOutboundRequests: 0,
        timerCount: 0,
      });
    }
    for (const snapshot of [result.afterFailure, result.afterDisconnect]) {
      expect(snapshot).toMatchObject({ listenerCount: 0, phase: 'disconnected' });
    }
    expect(result.afterClose).toEqual({
      listenerCount: 0,
      pendingCallbacks: 0,
      pendingInboundRequests: 0,
      pendingNotifications: 0,
      pendingOutboundRequests: 0,
      phase: 'closed',
      timerCount: 0,
    });
    await page.close();
  }

  it.each(['legacy-wire', 'official-sdk2'] as const)(
    'pins identity and quiescent replacement, failure, disconnect, and close lifecycle (%s)',
    verifyFrameLifecycle
  );
});
