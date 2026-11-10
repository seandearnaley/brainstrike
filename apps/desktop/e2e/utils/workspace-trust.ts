import { expect, type Locator } from '@playwright/test';

/**
 * ADR-0032: the person trusts the thread's folder from the composer's
 * workspace trust chip, so its AGENTS.md, skills, slash commands and subagents
 * load from the next run on. `conversation` is the thread's region (the
 * root's "Assistant").
 */
export async function trustWorkspaceFromComposer(conversation: Locator): Promise<void> {
  const chip = conversation.getByRole('button', { name: /^Workspace trust:/u });
  await chip.click();
  // The chip's popover is drawn in a layer above the conversation.
  await conversation
    .page()
    .getByRole('dialog', { exact: true, name: 'Workspace trust' })
    .getByRole('button', { exact: true, name: 'Trust folder' })
    .click();
  await expect(chip).toHaveCount(0);
}
