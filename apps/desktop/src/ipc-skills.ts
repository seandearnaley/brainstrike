import { ipcMain } from 'electron';
import { createSkillsScanHandler } from './ipc-skills-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Registers the Agent Skills scan IPC (desktop-only). The Settings → Skills
 * panel and the composer's "/" menu call `scan` to list every discovered
 * skill (ok / invalid / shadowed) across the four tiers.
 */
export function registerSkillsIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const scanSkillsHandler = createSkillsScanHandler();

  registry.registerInvoke('skills', DESKTOP_IPC_CHANNELS.skills.scan, () => scanSkillsHandler());

  return () => {
    registry.unregisterAll();
  };
}
