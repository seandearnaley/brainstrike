import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMcpAppSandboxPolicy,
  McpAppProvenanceAuthority,
  renderMcpAppResourceDocument,
  renderMcpAppSandboxShellDocument,
} from '../src/index.js';

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

  it('blocks CSP network, parent access, popups, downloads, and top navigation, then revokes URLs', async () => {
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
    const policy = buildMcpAppSandboxPolicy(resource.meta);
    const resourceDocument = renderMcpAppResourceDocument(resource, policy);
    const shellDocument = renderMcpAppSandboxShellDocument(resourceDocument, policy);
    const shellUrl = await page.evaluate(
      (documentText) => URL.createObjectURL(new Blob([documentText], { type: 'text/html' })),
      shellDocument
    );

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
      const frame = document.createElement('iframe');
      frame.id = 'mcp-app-shell';
      frame.sandbox.add('allow-scripts');
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

    await page.evaluate((shell) => {
      document.querySelector('#mcp-app-shell')?.remove();
      URL.revokeObjectURL(shell);
    }, shellUrl);
    await expect(page.evaluate((url) => fetch(url), shellUrl)).rejects.toThrow();
    await context.close();
  });
});
