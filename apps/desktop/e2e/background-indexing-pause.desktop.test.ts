import { expect, test } from './fixtures/electron-fixture';

test.describe('Background indexing pause controls', { tag: '@smoke' }, () => {
  test('toggles pause from settings and the footer status popover', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await expect(window.getByRole('navigation', { name: 'Settings categories' })).toBeVisible();

    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /Search & Indexing/i })
      .click();

    await expect(window.getByTestId('settings-category-search-indexing')).toBeVisible();

    const indexingSwitch = window.getByRole('switch', { name: /background indexing/i });
    await indexingSwitch.click();

    const pauseButton = window.getByRole('button', { name: /pause background indexing/i });
    await expect(pauseButton).toBeVisible();
    await pauseButton.click();

    await expect(
      window.getByRole('button', { name: /resume background indexing/i }).first()
    ).toBeVisible();

    const statusTrigger = window.getByTestId('collection-sync-status-trigger');
    await expect(statusTrigger).toBeVisible();
    await statusTrigger.click();

    const resumeFromFooter = window
      .getByRole('button', { name: /resume background indexing/i })
      .last();
    await expect(resumeFromFooter).toBeVisible();
    await resumeFromFooter.click();

    await expect(
      window.getByRole('button', { name: /pause background indexing/i }).first()
    ).toBeVisible();
  });
});
