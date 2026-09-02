import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAppProvenanceAuthority, renderMcpAppSandboxShell } from '../src/index.js';

const SCRIPT_CLOSE = '</script>';
const APP_HTML = `<!doctype html><script>
(async () => {
  const result = { fetchDenied: false, parentDenied: false, popupDenied: false, topDenied: false };
  try { void parent.document.body; } catch { result.parentDenied = true; }
  try { top.location.href = 'https://escape.invalid/'; } catch { result.topDenied = true; }
  result.popupDenied = window.open('https://popup.invalid/') === null;
  try { await fetch('https://network.invalid/'); } catch { result.fetchDenied = true; }
  const link = document.createElement('a');
  link.download = 'escape.txt';
  link.href = 'data:text/plain,escape';
  link.click();
  top.postMessage({ type: 'mcp-app-sandbox-result', value: result }, '*');
})();
${SCRIPT_CLOSE}`;

describe('real Chromium MCP Apps sandbox', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('blocks CSP network, parent access, popups, downloads, and top navigation through the header-served shell, then releases it', async () => {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const popups: unknown[] = [];
    const downloads: unknown[] = [];
    const diagnostics: string[] = [];
    page.on('popup', (popup) => popups.push(popup));
    page.on('download', (download) => downloads.push(download));
    page.on('console', (message) =>
      diagnostics.push(`console:${message.type()}:${message.text()}`)
    );
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`));

    const provenance = new McpAppProvenanceAuthority();
    const generation = provenance.openGeneration({ generation: 1, serverId: 'browser' });
    const tool = provenance.registerTool(generation, {
      _meta: { ui: { resourceUri: 'ui://browser/app' } },
      name: 'browser-app',
    });
    const resource = provenance.resolveResource(generation, tool, {
      mimeType: 'text/html;profile=mcp-app',
      text: APP_HTML,
      uri: 'ui://browser/app',
    });
    // Production serves the shell from its own origin with the policies as
    // RESPONSE HEADERS (desktop: the brainstrike-mcp-app: protocol). Model
    // exactly that: a routed origin, header CSP + Permissions-Policy, and a
    // release that turns the URL into a 404.
    const shell = renderMcpAppSandboxShell(resource);
    const shellUrl = 'https://mcp-app-shell.test/0123456789abcdef0123456789abcdef/';
    let released = false;
    await page.route(`${shellUrl}**`, async (route) => {
      if (released) {
        await route.fulfill({ body: 'Not found', status: 404 });
        return;
      }
      await route.fulfill({
        body: shell.document,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': shell.contentSecurityPolicy,
          'Permissions-Policy': shell.permissionsPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
        status: 200,
      });
    });

    await page.evaluate(() => {
      const results: unknown[] = [];
      Reflect.set(window, '__mcpSandboxResults', results);
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'mcp-app-sandbox-result') {
          results.push(event.data.value);
        }
      });
    });
    await page.evaluate((url) => {
      // The host frames the shell WITHOUT a sandbox attribute (it lives on
      // its own origin); only the shell's nested app frame is sandboxed.
      const frame = document.createElement('iframe');
      frame.id = 'mcp-app-shell';
      frame.src = url;
      document.body.append(frame);
    }, shellUrl);
    try {
      await page.waitForFunction(
        () => {
          const results = Reflect.get(window, '__mcpSandboxResults');
          return Array.isArray(results) && results.length === 1;
        },
        undefined,
        { timeout: 3000 }
      );
    } catch (error: unknown) {
      throw new Error(
        JSON.stringify({ diagnostics, frames: page.frames().map((frame) => frame.url()) }),
        { cause: error }
      );
    }
    const result = await page.evaluate(() => Reflect.get(window, '__mcpSandboxResults')?.[0]);
    expect(result).toEqual({
      fetchDenied: true,
      parentDenied: true,
      popupDenied: true,
      topDenied: true,
    });
    expect(page.url()).toBe('about:blank');
    expect(popups).toHaveLength(0);
    expect(downloads).toHaveLength(0);

    // The host can reach the app frame only as a cross-origin WindowProxy
    // (`shell.frames[0]`), never the shell document itself.
    expect(
      await page.evaluate(() => {
        const frame = document.querySelector('#mcp-app-shell');
        if (!(frame instanceof HTMLIFrameElement) || frame.contentWindow === null) {
          throw new Error('shell frame is unavailable');
        }
        return { appFrames: frame.contentWindow.length, shellDocument: frame.contentDocument };
      })
    ).toEqual({ appFrames: 1, shellDocument: null });

    released = true;
    await page.evaluate(() => document.querySelector('#mcp-app-shell')?.remove());
    expect(await page.evaluate((url) => fetch(url).then((r) => r.status), shellUrl)).toBe(404);
    await context.close();
  });
});
