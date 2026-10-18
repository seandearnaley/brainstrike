// Real Chromium proof of agent browsing's egress boundary (BST-1238). Main runs
// the real pane host, view manager, agent partition routing, proxy `login`
// answer and agent tools. The egress proxy runs in process with a fake DNS
// that resolves `public.test` to a public address and lands that address on a
// local "public" site. Each of the site's pages tries to reach a loopback
// "secret" server; the proof is that none of them can, while a user tab can.
// It also forks the real egress utility entry and has it refuse a literal.
import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { app, BrowserWindow, utilityProcess } from 'electron';
import {
  runBrowserGetPageText,
  runBrowserNavigate,
} from '../../assistant-server/browser-agent-tools';
import { createAgentBrowsingRoute } from '../../browser/agent-browsing-route';
import { AgentEgressHost } from '../../browser/agent-egress/agent-egress-host';
import { type EgressRefusal, startEgressProxy } from '../../browser/agent-egress/egress-proxy';
import { createBrowserPaneHost } from '../../browser/browser-pane-host';

const PUBLIC_ADDRESS = '93.184.216.34';
const SECRET = 'SECRET-BST-1238';

function report(event: string, detail: unknown): void {
  process.stdout.write(`${JSON.stringify({ detail, event })}\n`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('A fixture server did not bind a TCP port');
  }
  return address.port;
}

async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // The bundle is CommonJS, where neither __dirname survives Biome's rewrite
  // nor import.meta.dirname exists, so the test names the sibling entry.
  const egressEntry = process.env['BRAINSTRIKE_TEST_AGENT_EGRESS_ENTRY'];
  if (egressEntry === undefined) {
    throw new Error('The proof needs the bundled agent-egress-entry.js path');
  }
  await app.whenReady();
  const secretHits: string[] = [];
  const secret = createServer((request, response) => {
    secretHits.push(request.url ?? '');
    response.end(`<title>Secret</title>${SECRET}`);
  });
  const secretPort = await listen(secret);
  const secretUrl = `http://127.0.0.1:${secretPort}/secret`;
  const pages: Record<string, string> = {
    '/location': `<title>Location</title><script>location.href=${JSON.stringify(secretUrl)}</script>`,
    '/meta': `<title>Meta</title><meta http-equiv="refresh" content="0;url=${secretUrl}">`,
    '/ok': '<title>Public</title><p>public page body</p>',
    '/popup': `<title>Popup</title><script>window.open(${JSON.stringify(secretUrl)})</script>`,
  };
  const site = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/redirect') {
      response.writeHead(302, { location: secretUrl }).end();
      return;
    }
    if (path === '/redirect-https') {
      response.writeHead(302, { location: `https://127.0.0.1:${secretPort}/secret` }).end();
      return;
    }
    if (path === '/redirect-localhost') {
      response.writeHead(302, { location: `http://localhost:${secretPort}/secret` }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(pages[path] ?? 'not found');
  });
  const sitePort = await listen(site);

  const refusals = new Map<string, EgressRefusal>();
  const password = 'per-launch-test-secret';
  const proxy = await startEgressProxy({
    credential: `agent:${password}`,
    dial: (address, port) =>
      address === PUBLIC_ADDRESS
        ? connect({ host: '127.0.0.1', port: sitePort })
        : connect({ host: address, port }),
    onRefusal: (refusal) => {
      refusals.set(refusal.reason === 'malformed' ? refusal.target : refusal.host, refusal);
    },
    resolve: async (host) =>
      host === 'public.test'
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : (await lookup(host, { all: true })).map(({ address, family }) => ({
            address,
            family: family === 6 ? 6 : 4,
          })),
  });
  const route = createAgentBrowsingRoute({
    ensure: () => Promise.resolve({ password, port: proxy.port, username: 'agent' }),
    refusalFor: (host) => refusals.get(host.toLowerCase()),
  });

  const window = new BrowserWindow({ height: 600, show: false, width: 800 });
  await window.loadURL('about:blank');
  const pane = createBrowserPaneHost(window, route);
  pane.manager.setBounds({ height: 500, width: 700, x: 0, y: 0 });
  const options = { pollMs: 50, timeoutMs: 10_000 };
  const activeAgentTab = () =>
    pane.manager.listTabs().find((tab) => tab.owner === 'agent' && tab.active);
  const pageText = async () => {
    const read = await runBrowserGetPageText({ maxChars: 2000 }, pane);
    return read.ok ? read.text : `(read failed: ${read.error})`;
  };
  /** A client redirect fails after navigate settles; wait for its failure. */
  const laterFailure = async (tabId: string) => {
    for (let waited = 0; waited < 5000; waited += 100) {
      const error = pane.manager.getNavigationError(tabId);
      if (error !== null) {
        return error;
      }
      await settle(100);
    }
    return null;
  };

  report('public', {
    navigate: await runBrowserNavigate({ url: 'http://public.test/ok' }, pane, options),
    text: await pageText(),
  });
  for (const path of ['/redirect', '/redirect-https', '/redirect-localhost']) {
    report(`server-redirect ${path}`, {
      navigate: await runBrowserNavigate({ url: `http://public.test${path}` }, pane, options),
      text: await pageText(),
    });
  }
  for (const path of ['/location', '/meta']) {
    const navigate = await runBrowserNavigate({ url: `http://public.test${path}` }, pane, options);
    const tab = activeAgentTab();
    report(`client-redirect ${path}`, {
      failure: tab ? await laterFailure(tab.tabId) : 'no agent tab',
      navigate,
      text: await pageText(),
    });
  }
  const before = pane.manager.listTabs().length;
  await runBrowserNavigate({ url: 'http://public.test/popup' }, pane, options);
  await settle(300);
  const popup = pane.manager.listTabs().at(-1);
  report('popup', {
    failure:
      popup && pane.manager.listTabs().length > before ? await laterFailure(popup.tabId) : null,
    opened: pane.manager.listTabs().length - before,
    owner: popup?.owner ?? null,
    text: await pageText(),
  });
  // Bypassing the tool's literal check: the partition itself must not reach loopback.
  for (const url of [secretUrl, `http://localhost:${secretPort}/secret`]) {
    const tabId = pane.manager.createTab(url, 'agent');
    report(`direct ${url.includes('localhost') ? 'localhost' : 'literal'}`, {
      failure: await laterFailure(tabId),
    });
  }
  report('secret-hits-agent', secretHits.length);

  // The real utility entry: a literal loopback CONNECT is refused and reported.
  const egress = new AgentEgressHost(() =>
    utilityProcess.fork(egressEntry, [], {
      serviceName: 'brainstrike-agent-egress-proof',
    })
  );
  const running = await egress.ensure();
  const status = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: running.port }, () => {
      const credential = Buffer.from(`${running.username}:${running.password}`).toString('base64');
      socket.write(
        `CONNECT 127.0.0.1:${secretPort} HTTP/1.1\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`
      );
    });
    socket.once('data', (chunk) => {
      resolve(chunk.toString('latin1').split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.once('error', reject);
  });
  await settle(100);
  report('utility', { refusal: egress.refusalFor('127.0.0.1') ?? null, status });
  await egress.close();

  // Control: the user's own tab is unaffected and reaches the secret server,
  // so the zero hits above are the boundary, not an unreachable server.
  const userTab = pane.manager.createTab(secretUrl);
  for (let waited = 0; waited < 5000 && secretHits.length === 0; waited += 100) {
    await settle(100);
  }
  report('user-tab', {
    error: pane.manager.getNavigationError(userTab),
    owner: pane.manager.listTabs().find((tab) => tab.tabId === userTab)?.owner ?? null,
    secretHits: secretHits.length,
  });
  pane.dispose();
  await proxy.close();
  secret.close();
  site.close();
}

main().then(
  () => {
    report('done', null);
    app.exit(0);
  },
  (error: unknown) => {
    report('failure', error instanceof Error ? (error.stack ?? error.message) : String(error));
    app.exit(1);
  }
);
