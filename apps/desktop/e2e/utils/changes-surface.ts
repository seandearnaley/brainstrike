import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { setupAssistantMock } from './assistant-mock';
import { ensureAssistantShellVisible } from './layout-helpers';
import { seedRoot } from './seed-root';

/** Opens `repo` as the workspace root and the Changes surface beside it. */
export async function openChanges(page: Page, repo: string, reloadReason: string): Promise<void> {
  await seedRoot(page, repo, { reloadReason, rootId: randomUUID() });
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  await page.getByTestId('workspace-add-tab').click({ timeout: 15_000 });
  await page.getByRole('menuitem', { name: /Changes/u }).click({ timeout: 15_000 });
}

/**
 * Choose a scope with the keyboard, as the other submenu specs do: a pointer
 * moving into a submenu that is still opening can cross the parent menu, which
 * closes the submenu under the click.
 */
export async function chooseScope(page: Page, scope: 'staged' | 'unstaged'): Promise<void> {
  const surface = page.getByTestId('changes-surface');
  await surface.getByTestId('changeset-source-picker-trigger').click({ timeout: 30_000 });
  const worktree = page.getByTestId('changeset-source-worktree').first();
  await worktree.focus({ timeout: 30_000 });
  await page.keyboard.press('ArrowRight');
  await expect(worktree).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { exact: true, name: scope }).focus();
  await page.keyboard.press('Enter');
}

export const diffOf = (page: Page): Locator =>
  page.getByTestId('changes-surface').getByTestId('diff-review');
