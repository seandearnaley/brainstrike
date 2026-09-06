import type { IpcMainInvokeEvent } from 'electron';
import { vi } from 'vitest';
import { assignWindowRole, type DesktopWindowRole } from '../../window-role';
import { createAllowlistedSenderFrame } from './desktop-ipc-sender-frame-test-allowlist';

export { createAllowlistedSenderFrame } from './desktop-ipc-sender-frame-test-allowlist';

/** Tracks `webContentsId` under `role` in the window-role map (module state,
 * so it resets per test file). Idempotent. */
export function trackTestWindowRole(webContentsId: number, role: DesktopWindowRole): void {
  assignWindowRole(
    {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { id: webContentsId },
    } as never,
    role
  );
}

const DEFAULT_TRUSTED_SENDER_ID: Record<DesktopWindowRole, number> = {
  'chunking-host': 990_002,
  'embedding-host': 990_003,
  'llm-host': 990_004,
  'visible-ui': 990_001,
};

/**
 * Builds an invoke event that passes BOTH authorization factors for `role`:
 * the sender id is tracked under that role and the frame URL is allowlisted.
 */
export function createTrustedInvokeEvent(
  role: DesktopWindowRole = 'visible-ui',
  webContentsId: number = DEFAULT_TRUSTED_SENDER_ID[role]
): IpcMainInvokeEvent {
  trackTestWindowRole(webContentsId, role);
  return {
    sender: { id: webContentsId },
    senderFrame: createAllowlistedSenderFrame(role),
  } as unknown as IpcMainInvokeEvent;
}
