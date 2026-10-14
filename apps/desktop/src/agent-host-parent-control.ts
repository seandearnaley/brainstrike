import type { AgentHost } from '@brainstrike/agent-host';
import type { ClearContentResult } from '@brainstrike/state-store';
import { bindDesktopClientPort } from './agent-host-platform/desktop-client-port';
import { installParentPlatformPort } from './agent-host-platform/parent-platform-port';
import { decodeHostLeaseControl, decodeHostLeaseParentMessage } from './host-lease-control';
import { installHostLifetimePort } from './host-lifetime-port';

/** Keep the existing strict decoders and port ownership ahead of kernel import. */
export function receiveAgentHostParentMessage(
  input: unknown,
  host: AgentHost | undefined,
  cancel: () => void
): Promise<ClearContentResult> | undefined {
  if (
    installParentPlatformPort(input) ||
    installHostLifetimePort(input, cancel) ||
    bindDesktopClientPort(input, host)
  ) {
    return;
  }
  const control = decodeHostLeaseControl(decodeHostLeaseParentMessage(input).data);
  if (control.method === 'clear-content') {
    if (!host) {
      throw new Error('Content clear requires a ready owned host');
    }
    return host.clearAndRetireContent();
  }
  cancel();
  return;
}
