import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findFastShardDbReadinessViolations } from '../check-e2e-readiness-contracts.mjs';

test('flags default app-load DB readiness outside isolated test ranges', () => {
  const source = `
    import { test } from '@playwright/test';
    import { waitForAppLoad } from './utils/layout-helpers';

    test('shell test', async ({ page }) => {
      await waitForAppLoad(page);
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/shell.test.ts'), [
    {
      file: 'apps/web/e2e/shell.test.ts',
      line: 6,
      reason: 'waitForAppLoad defaults to DB readiness in a fast functional path',
    },
  ]);
});

test('allows explicit shell-only app-load readiness outside isolated test ranges', () => {
  const source = `
    import { test } from '@playwright/test';
    import { waitForAppLoad } from './utils/layout-helpers';

    test('shell test', async ({ page }) => {
      await waitForAppLoad(page, { waitForDatabase: false });
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/shell.test.ts'), []);
});

test('flags default resetLayoutState DB readiness outside isolated test ranges', () => {
  const source = `
    import { test } from '@playwright/test';
    import { resetLayoutState } from './utils/layout-helpers';

    test('layout test', async ({ page }) => {
      await resetLayoutState(page);
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/layout.test.ts'), [
    {
      file: 'apps/web/e2e/layout.test.ts',
      line: 6,
      reason: 'resetLayoutState defaults to DB readiness in a fast functional path',
    },
  ]);
});

test('flags default HomePage.goto DB readiness outside isolated test ranges', () => {
  const source = `
    import { test } from '@playwright/test';

    test('settings test', async ({ page }) => {
      const home = new HomePage(page);
      await home.goto();
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/settings.test.ts'), [
    {
      file: 'apps/web/e2e/settings.test.ts',
      line: 6,
      reason: 'HomePage.goto defaults to DB readiness in a fast functional path',
    },
  ]);
});

test('ignores DB readiness inside stateful and destructive title ranges', () => {
  const source = `
    import { test } from '@playwright/test';
    import { waitForAppLoad } from './utils/layout-helpers';

    test.describe('db suite @stateful', () => {
      test('db test', async ({ page }) => {
        await waitForAppLoad(page);
      });
    });

    test.describe('reset suite @destructive', () => {
      test('reset test', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
      });
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/db.test.ts'), []);
});

test('ignores top-level helpers when every test in the file is isolated', () => {
  const source = `
    import { test } from '@playwright/test';
    import { waitForAppLoad } from './utils/layout-helpers';

    async function setup(page) {
      await waitForAppLoad(page);
    }

    test.describe('db suite @stateful', () => {
      test('db test', async ({ page }) => {
        await setup(page);
      });
    });
  `;

  assert.deepEqual(findFastShardDbReadinessViolations(source, 'apps/web/e2e/db.test.ts'), []);
});
