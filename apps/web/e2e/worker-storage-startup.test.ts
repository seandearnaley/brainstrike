import { expect, type Worker as PlaywrightWorker, test } from '@playwright/test';
import { waitForAppLoad } from './utils/layout-helpers';

test('starts the file-explorer storage module Worker without runtime errors @web-smoke', async ({
  page,
}) => {
  const startupErrors: string[] = [];
  const workerUrls: string[] = [];
  const workers: PlaywrightWorker[] = [];

  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      (text.includes('worker-storage') || text.includes('module is not defined'))
    ) {
      startupErrors.push(`console: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    if (error.message.includes('module is not defined')) {
      startupErrors.push(`page: ${error.message}`);
    }
  });
  page.on('worker', (worker) => {
    workerUrls.push(worker.url());
    workers.push(worker);
  });

  await page.goto('/');
  await waitForAppLoad(page, { waitForDatabase: false });

  await expect
    .poll(() => workerUrls, { timeout: 15_000 })
    .toEqual(expect.arrayContaining([expect.stringMatching(/worker-storage\.worker/i)]));

  const storageWorker = workers.find((worker) => /worker-storage\.worker/i.test(worker.url()));
  if (!storageWorker) {
    throw new Error('WorkerStorage module Worker was not captured');
  }
  await expect(storageWorker.evaluate(() => self.location.href)).resolves.toMatch(
    /worker-storage\.worker/i
  );
  expect(startupErrors).toEqual([]);
});
