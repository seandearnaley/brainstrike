import path from 'node:path';
import { WORKTREE_BRANCH_PREFIX } from '@brainstrike/types';
import { expect, type Locator, type Page } from '@playwright/test';
import { openWhereMenu, pageOf, whereChip } from './where-control';

export interface CreatedWorktree {
  /** The default branch, `bs/<name>`. */
  readonly branch: string;
  /** The worktree's folder name, which the where-control's label shows. */
  readonly name: string;
  readonly worktreePath: string;
}

/**
 * New worktree… in the where-control (ADR-0034, BST-2506): one click makes a
 * worktree with the defaults and moves the thread into it. The control then
 * names it: its title is the worktree's folder and its label reads
 * `<project> · <name>`. Returns once the operation has ended, as a person
 * waits for "Worktree operation in progress." to go.
 *
 * For a repository whose setup script has no answer the row opens the create
 * sheet instead; a spec about that drives the sheet itself.
 */
export async function createAndUseWorktree(scope: Locator | Page): Promise<CreatedWorktree> {
  const chip = whereChip(scope);
  const before = await chip.getAttribute('title');
  expect(before).toBeTruthy();
  await openWhereMenu(scope);
  await pageOf(scope).getByTestId('workspace-bar-mode-new-worktree').click();
  // The thread moves before the operation ends; the control is busy until it has.
  await expect
    .poll(
      async () => {
        const title = await chip.getAttribute('title');
        const busy = await chip.getAttribute('aria-busy');
        return busy !== 'true' && title !== null && title !== before && path.isAbsolute(title);
      },
      { timeout: 90_000 }
    )
    .toBe(true);
  const worktreePath = (await chip.getAttribute('title')) ?? '';
  const name = path.basename(worktreePath);
  await expect(chip).toContainText(`· ${name}`);
  return { branch: `${WORKTREE_BRANCH_PREFIX}${name}`, name, worktreePath };
}
