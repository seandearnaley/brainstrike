import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { McpAppProvenanceAuthority } from '../src/index.js';

it('admits an unminified official SDK app within the production resource budget', async () => {
  const entry = createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps');
  const output = await build({
    bundle: true,
    format: 'iife',
    logLevel: 'silent',
    platform: 'browser',
    stdin: {
      contents: `
        import { App, PostMessageTransport } from ${JSON.stringify(entry)};
        const app = new App({ name: 'resource-budget', version: '1.0.0' }, {});
        void app.connect(new PostMessageTransport(window.parent, window.parent));
      `,
      resolveDir: import.meta.dirname,
    },
    target: 'chrome136',
    write: false,
  });
  const script = output.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error('Official SDK app bundle is missing');
  }
  const html = `<!doctype html><script>${script.replaceAll('</script>', '<\\/script>')}</script>`;
  const authority = new McpAppProvenanceAuthority();
  const generation = authority.openGeneration({ generation: 1, serverId: 'budget-server' });
  const uri = 'ui://budget/app';
  const tool = authority.registerTool(generation, {
    _meta: { ui: { resourceUri: uri } },
    name: 'budget-app',
  });
  expect(
    authority.resolveResource(generation, tool, {
      mimeType: 'text/html;profile=mcp-app',
      text: html,
      uri,
    }).html
  ).toBe(html);
});
