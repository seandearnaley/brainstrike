import { expect, type Locator } from '@playwright/test';

/**
 * ADR-0032: the person trusts the thread's folder from the composer's prompt,
 * so its AGENTS.md, skills, slash commands and subagents load from the next
 * run on. `conversation` is the thread's region (the root's "Assistant").
 */
export async function trustWorkspaceFromComposer(conversation: Locator): Promise<void> {
  const prompt = conversation.getByRole('region', { exact: true, name: 'Workspace trust' });
  await prompt.getByRole('button', { exact: true, name: 'Trust folder' }).click();
  await expect(prompt).toHaveCount(0);
}
