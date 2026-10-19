import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { createHostAuthority, createHostCredentials } from '@brainstrike/host-capabilities';
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
 *
 * The admission reads credentials through the host's one credential authority,
 * as `createDesktopHostConfiguration` composes it (BST-754). Here it holds a
 * disposable profile store that no scenario writes, so its file never exists,
 * and no environment.
 */
export function desktopAdmission(
  dependencies: MainArgs[0],
  savedPolicy?: () => Promise<PermissionToolGateSnapshot | undefined>,
  ...rest: MainArgs extends [unknown, ...infer Rest] ? Rest : never
): ReturnType<typeof productionDesktopCapabilities> & DesktopRunAdmission {
  const capabilities = productionDesktopCapabilities(dependencies, ...rest);
  const auth = createHostAuthority({
    credentials: createHostCredentials({
      selection: {
        kind: 'file',
        path: join(tmpdir(), `bs-desktop-admission-${randomUUID()}`, 'credentials.json'),
      },
    }),
    env: {},
  });
  return {
    ...capabilities,
    ...createDesktopRunAdmission(
      capabilities.admission,
      async () => await savedPolicy?.(),
      (provider, origin) => auth.resolveProviderAuth(provider, origin)
    ),
  };
}
