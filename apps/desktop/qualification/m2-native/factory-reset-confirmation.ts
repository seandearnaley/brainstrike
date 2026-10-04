import type { Page } from '@playwright/test';

export const FACTORY_RESET_PROMPT =
  'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Continue?';

/** One-shot native decision, matching the established desktop reset fixture. */
export function acceptNextFactoryResetConfirmation(expectedMessage: string): void {
  const target = globalThis as typeof globalThis & {
    m2FactoryResetConfirmationObserved?: (message: string) => void;
  };
  const original = globalThis.confirm;
  if (typeof original !== 'function') {
    throw new Error('Native confirmation capability is unavailable.');
  }
  const observed = target.m2FactoryResetConfirmationObserved;
  if (typeof observed !== 'function') {
    throw new Error('Factory Reset confirmation observer is unavailable.');
  }
  globalThis.confirm = (message?: string): boolean => {
    globalThis.confirm = original;
    if (message !== expectedMessage) {
      throw new Error('Expected the production Factory Reset confirmation.');
    }
    observed(message);
    return true;
  };
}

export async function resetFromUi(
  page: Page,
  record: (phase: string, value: unknown) => Promise<void>
): Promise<void> {
  const {
    promise: confirmation,
    resolve: observed,
    reject: observationFailed,
  } = Promise.withResolvers<string>();
  await page.exposeFunction('m2FactoryResetConfirmationObserved', async (message: unknown) => {
    if (message !== FACTORY_RESET_PROMPT) {
      observationFailed(new Error('Expected the production Factory Reset confirmation.'));
      return;
    }
    try {
      await record('factory-reset-confirmation', {
        adapter: 'one-shot native confirmation input',
        message,
      });
      observed(message);
    } catch (error) {
      observationFailed(error);
    }
  });
  await page.evaluate(acceptNextFactoryResetConfirmation, FACTORY_RESET_PROMPT);
  await Promise.all([
    confirmation,
    page.waitForEvent('domcontentloaded', { timeout: 60_000 }),
    page.getByTestId('factory-reset-button').click(),
  ]);
}
