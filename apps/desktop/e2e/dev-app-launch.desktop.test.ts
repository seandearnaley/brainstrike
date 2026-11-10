import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { configureAssistantProvider } from './utils/assistant-mock';
import { launchElectronAppWithOptions, reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import { runViteCacheDir } from './utils/run-vite-cache';
import { seedRoot } from './utils/seed-root';

// Regression: the renderer's Send schema once imported a Node-only module through
// platform-wire. Production tree shaking hid its node:v8 import; dev evaluated it.
test('dev renderer sends Luna cache usage and reloads without losing the thread', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-dev-launch-'));
  const workspace = path.join(profile, 'workspace');
  await mkdir(workspace);
  const reply = 'Why did the developer cross the road? To get to the other site.';
  const provider = await startModelProviderShim({
    finalText: reply,
    responsesUsage: {
      input_tokens: 100,
      input_tokens_details: { cache_write_tokens: 10, cached_tokens: 60 },
      output_tokens: 25,
      total_tokens: 125,
    },
  });
  let joined = false;
  // On a hosted runner the optimizer committed the dependency scan's result before the
  // renderer's crawl reached every import, so each dependency the scan missed re-optimized and
  // reloaded the renderer mid-launch (BST-2091). Global setup commits that scan before any
  // request; served from a copy of it with discovery on, every dependency the scan missed is
  // optimized late, however fast the runner (BST-2469). The copy is this spec's own, so a late
  // one never rewrites the cache other workers read; the `.vite` name keeps the React
  // transform's exclusion of optimized chunks.
  const cacheDir = path.join(profile, '.vite');
  await cp(runViteCacheDir(), cacheDir, { recursive: true });
  const server = await createServer({
    cacheDir,
    configFile: path.resolve('vite.config.mts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer;
    const scanned = new Set(Object.keys(optimizer?.metadata.optimized ?? {}));
    if (!optimizer || scanned.size === 0) {
      throw new Error('The dev renderer did not start from the dependency scan global setup ran');
    }
    const rendererUrl = server.resolvedUrls?.local[0];
    if (!rendererUrl) {
      throw new Error('Dev renderer URL unavailable');
    }
    const context = await launchElectronAppWithOptions({
      env: { ['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']: rendererUrl },
      launchMode: 'dev-server',
      modelProvider: provider,
      userDataDir: profile,
      workspaceRoot: workspace,
    });
    const child = context.app.process();
    try {
      const errors: string[] = [];
      context.window.on('pageerror', (error) => errors.push(error.message));
      await expect(context.window.getByTestId('new-agent-button')).toBeVisible();
      const page = context.window;
      await seedRoot(page, workspace, {
        reloadReason: 'luna-cache-usage',
        rootId: randomUUID(),
      });
      await configureAssistantProvider(page, {
        apiKey: 'test-key-luna-cache-usage',
        compositeModelKey: 'openai::gpt-6-luna',
        provider: 'openai',
      });
      await ensureAssistantShellVisible(page);
      const region = page.getByRole('region', { exact: true, name: 'Assistant' });
      await region.getByRole('textbox', { name: 'Message input' }).fill('Tell me a joke.');
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(reply, { exact: true })).toBeVisible();
      // The reply and its thread title each report the scripted Luna usage ($0.0000174 apiece).
      await expect(region.getByTestId('context-usage-trigger-cost')).toContainText('$0.000035');
      await reloadRenderer(context.window, 'dev-app-launch: reload');
      await expect(region.getByText(reply, { exact: true })).toBeVisible();
      await expect(region.getByTestId('context-usage-trigger-cost')).toContainText('$0.000035');
      expect(provider.refusals()).toEqual([]);
      await expect(context.window.getByTestId('new-agent-button')).toBeVisible();
      expect(errors).toEqual([]);
      const { discovered, optimized } = optimizer.metadata;
      const late = [...Object.keys(optimized), ...Object.keys(discovered)].filter(
        (dependency) => !scanned.has(dependency)
      );
      expect(late).toEqual([]);
    } finally {
      await context.app.close();
      joined = true;
      expect(child.exitCode).toBe(0);
    }
  } finally {
    await server.close();
    await provider.close();
    if (joined) {
      await rm(profile, { force: true, recursive: true });
    }
  }
});
