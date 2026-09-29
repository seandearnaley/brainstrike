import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { skillsContract } from './ipc-domains/skills.contract';
import { createSkillsScanHandler } from './ipc-skills-handlers';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/**
 * Registers the Agent Skills scan IPC (desktop-only). The Settings → Skills
 * panel and the composer's "/" menu call `scan` to list every discovered
 * skill (ok / invalid / shadowed) across the four tiers.
 */
export function registerSkillsIpcHandlers(
  scanSkills: () => Promise<SkillsScanResultSummary> = createSkillsScanHandler()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'skills', skillsContract, {
    scan: () => settleIpcResult({ category: 'skills', code: 'scan_failed' }, scanSkills),
  });
  return () => {
    registry.unregisterAll();
  };
}
