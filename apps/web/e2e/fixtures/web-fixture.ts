/**
 * Web E2E Test Fixtures (BST-180)
 *
 * Extends Playwright's base test with enhanced diagnostics collection.
 * Tests can import `test` from this file instead of '@playwright/test'
 * to automatically capture failure artifacts.
 */

import {
  createFailureCollector,
  type FailureArtifactCollector,
} from '@brainstrike/test-utils/playwright';
import type { TestInfo } from '@playwright/test';
import { test as base, expect as baseExpect } from '@playwright/test';

type WebTestFixtures = {
  /** Failure artifact collector - automatically captures diagnostics on test failure */
  failureCollector: FailureArtifactCollector;
};

export const test = base.extend<WebTestFixtures>({
  // BST-180: Failure artifact collector for enhanced test diagnostics
  failureCollector: async ({ page }, use, testInfo: TestInfo) => {
    const collector = createFailureCollector(page);

    await use(collector);

    // After test completes, attach diagnostics if the test failed
    await collector.attachDiagnosticsOnFailure(testInfo);
    collector.detach();
  },
});

export const expect = baseExpect;
