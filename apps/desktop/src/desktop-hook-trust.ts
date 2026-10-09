import { hostHookApprovalFor } from '@brainstrike/agent-host/hook-trust';
import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';

type HostRequest = <M extends HostMethod>(
  method: M,
  params: HostParams<M>
) => Promise<HostResults[M]>;

/** Main's view of the host-owned hook trust. */
export interface DesktopHookTrust {
  /** The hash a root's project hooks may run at: the host's trust at this same path. */
  approval(root: {
    readonly absPath: string;
    readonly rootId: string;
  }): Promise<string | undefined>;
  trust(params: HostParams<'hooks/trust'>): Promise<void>;
  untrust(rootId: string): Promise<void>;
}

/** `request` is Main's own client of the host this app launched. */
export function createDesktopHookTrust(request: HostRequest): DesktopHookTrust {
  return {
    approval: async ({ absPath, rootId }) => {
      const { trust } = await request('hooks/trust/read', { rootId });
      return hostHookApprovalFor(trust, absPath);
    },
    trust: async (params) => {
      await request('hooks/trust', params);
    },
    untrust: async (rootId) => {
      await request('hooks/untrust', { rootId });
    },
  };
}
