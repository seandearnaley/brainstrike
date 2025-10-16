import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';

test.describe('Embedding Worker Telemetry', () => {
  test('surfaces queue metrics and vector trends in settings', async ({ page }) => {
    const home = new HomePage(page);

    await home.goto();
    await home.navigateToSettings();

    const embeddingWorkerNav = page.getByRole('button', { name: 'Embedding Worker' });
    await expect(embeddingWorkerNav).toBeVisible();
    await embeddingWorkerNav.click();

    const embeddingCategory = page.getByTestId('settings-category-embedding-worker');
    await expect(embeddingCategory).toBeVisible();

    const queueHeading = embeddingCategory.getByRole('heading', { name: 'Queue' }).first();
    await expect(queueHeading).toBeVisible();
    await expect(
      embeddingCategory.getByRole('button', { name: 'Retry failed jobs' }).first()
    ).toBeVisible();
    await expect(embeddingCategory.getByText(/Jobs\/min/i)).toBeVisible();
    await expect(
      embeddingCategory.getByRole('img', { name: 'Queue throughput trend' })
    ).toBeVisible();
    await expect(embeddingCategory.getByRole('img', { name: 'Queue error trend' })).toBeVisible();

    const vectorStatusHeading = embeddingCategory.getByRole('heading', { name: 'Vector Status' });
    await expect(vectorStatusHeading).toBeVisible();
    await expect(embeddingCategory.getByText(/Latency \(ms\)/i)).toBeVisible();
    await expect(embeddingCategory.getByRole('img', { name: 'Queue latency trend' })).toBeVisible();
  });
});
