import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {} from '@vitest/browser-playwright';
import { preview } from 'vite';
import type { BrowserCommand } from 'vitest/node';
import type { ProductionMeasurement } from './src/__tests__/committed-production/receipt';

/** Registered in normal browser verification; BST-1929 retains the quarantined gate. */
export const measureCommittedProduction: BrowserCommand<[{ timeout: number }]> = async (
  { page },
  { timeout }
): Promise<ProductionMeasurement> => {
  const providerBrowser = page.context().browser();
  if (!providerBrowser) {
    throw new Error('Production measurement requires the browser provider');
  }
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-committed-production-'));
  const configFile = resolve(import.meta.dirname, 'vite.committed-production.config.mts');
  const buildOptions = { outDir: directory };
  try {
    // Vitest owns NODE_ENV=test. Vite's normal production CLI in a child
    // preserves the shipped config without changing another suite's env.
    const vite = resolve(
      dirname(createRequire(import.meta.url).resolve('vite/package.json')),
      'bin/vite.js'
    );
    const buildEnvironment = { ...process.env };
    buildEnvironment['NODE_ENV'] = 'production';
    await promisify(execFile)(
      process.execPath,
      [vite, 'build', '--config', configFile, '--outDir', directory, '--logLevel', 'warn'],
      {
        env: buildEnvironment,
      }
    );
    const server = await preview({
      build: buildOptions,
      configFile,
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    try {
      const address = server.httpServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Preview has no loopback port');
      }
      // Own the browser process as well as its disposable context: previous
      // development suites must not determine the production renderer lifetime.
      const browser = await providerBrowser.browserType().launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { height: 800, width: 900 } });
        try {
          const externalRequests: string[] = [];
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.hostname === '127.0.0.1') {
              return route.continue();
            }
            externalRequests.push(url.origin);
            return route.abort('blockedbyclient');
          });
          const productionPage = await context.newPage();
          const errors: string[] = [];
          productionPage.on('pageerror', (error) => errors.push(error.message));
          await productionPage.goto(`http://127.0.0.1:${address.port}/`);
          await productionPage.waitForFunction(
            () =>
              window.committedProductionMeasurement !== undefined ||
              window.committedProductionError !== undefined,
            undefined,
            { timeout }
          );
          const result = await productionPage.evaluate(() => ({
            error: window.committedProductionError,
            measurement: window.committedProductionMeasurement,
          }));
          if (result.error || errors.length || externalRequests.length) {
            throw new Error(JSON.stringify({ ...result, errors, externalRequests }));
          }
          if (!result.measurement) {
            throw new Error('Production measurement produced no receipt');
          }
          return result.measurement;
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.httpServer.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};
