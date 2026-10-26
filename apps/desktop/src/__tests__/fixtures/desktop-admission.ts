import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  createDesktopRunAdmission,
  type DesktopRunAdmission,
} from '../../agent-host-platform/desktop-run-admission';
import { productionDesktopCapabilities } from '../../agent-host-platform/production-desktop-capabilities';

type MainArgs = Parameters<typeof productionDesktopCapabilities>;

/**
 * Main's production capabilities with the agent host's run admission composed
 * from their reads, in one process (BST-1930 stage e): what the host admits
 * over the private connection, without the wire. The saved policy is the
 * host's; a scenario supplies it here.
 */
export function desktopAdmission(
  dependencies: MainArgs[0],
  savedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  ...rest: MainArgs extends [unknown, ...infer Rest] ? Rest : never
): ReturnType<typeof productionDesktopCapabilities> & DesktopRunAdmission {
  const capabilities = productionDesktopCapabilities(dependencies, ...rest);
  return {
    ...capabilities,
    ...createDesktopRunAdmission(capabilities.admission, async () => await savedPolicy?.()),
  };
}
