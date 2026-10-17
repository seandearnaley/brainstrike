import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createLogger, createServer } from 'vite';
import { configureAssistantProvider } from './utils/assistant-mock';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// Regression: the renderer's Send schema imported the native indexer through
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
  // A hosted runner starts with no optimized-dependency cache. On its 2 vCPUs the optimizer
  // committed before its crawl reached every import, and each dependency it met later
  // re-optimized and reloaded the renderer mid-launch (BST-2091). This server optimizes
  // cold and commits the scan's result at once, as that runner did, recording each late one.
  // Its cache is its own, so the forced optimize never rewrites one another spec is serving;
  // the `.vite` name keeps the React transform's exclusion of optimized chunks.
  const lateOptimizations: string[] = [];
  const logger = createLogger();
  const logInfo = logger.info;
  logger.info = (message, options) => {
    if (/optimized dependencies changed|dependenc(?:y|ies) optimized:/u.test(message)) {
      lateOptimizations.push(message);
    }
    logInfo(message, options);
  };
  const server = await createServer({
    cacheDir: path.join(profile, '.vite'),
    configFile: path.resolve('vite.config.mts'),
    customLogger: logger,
    optimizeDeps: { force: true, holdUntilCrawlEnd: false },
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const rendererUrl = server.resolvedUrls?.local[0];
    if (!rendererUrl) {
      throw new Error('Dev renderer URL unavailable');
    }
    const context = await launchElectronAppWithOptions({
      disableExternalLocalRuntimeProbes: true,
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
        disableBackgroundIndexing: true,
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
      await expect(region.getByTestId('context-usage-trigger-cost')).toContainText('$0.000017');
      await context.window.reload();
      await expect(region.getByText(reply, { exact: true })).toBeVisible();
      await expect(region.getByTestId('context-usage-trigger-cost')).toContainText('$0.000017');
      expect(provider.refusals()).toEqual([]);
      await expect(context.window.getByTestId('new-agent-button')).toBeVisible();
      expect(errors).toEqual([]);
      expect(lateOptimizations).toEqual([]);
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
