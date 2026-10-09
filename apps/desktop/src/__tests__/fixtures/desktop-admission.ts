import {
  createDesktopRunAdmission,
  type DesktopRunAdmission,
} from '../../agent-host-platform/desktop-run-admission';
import { productionDesktopCapabilities } from '../../agent-host-platform/production-desktop-capabilities';

/**
 * Main's production capabilities with the agent host's run admission composed
 * from their reads, in one process (BST-1930 stage e): what the host admits
 * over the private connection, without the wire.
 */
export function desktopAdmission(
  ...args: Parameters<typeof productionDesktopCapabilities>
): ReturnType<typeof productionDesktopCapabilities> & DesktopRunAdmission {
  const capabilities = productionDesktopCapabilities(...args);
  return { ...capabilities, ...createDesktopRunAdmission(capabilities.admission) };
}
