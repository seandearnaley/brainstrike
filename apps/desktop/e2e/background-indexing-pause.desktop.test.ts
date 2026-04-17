import { expect, test } from './fixtures/electron-fixture';

test.describe('Background indexing pause controls', { tag: '@smoke' }, () => {
  test('hide manual pause controls while background indexing is inactive', async ({
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

    await expect(window.getByRole('button', { name: /pause background indexing/i })).toHaveCount(0);
    await expect(window.getByRole('button', { name: /resume background indexing/i })).toHaveCount(
      0
    );
  });
});
