import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';

type HostRequest = <M extends HostMethod>(
  method: M,
  params: HostParams<M>
) => Promise<HostResults[M]>;

/** Main's view of the host-owned hook approval, which the host records for a root's repository. */
export interface DesktopHookTrust {
  /** The hash the project hooks of the root at `absPath` may run at; none when nothing is approved. */
  approval(absPath: string): Promise<string | undefined>;
  trust(params: HostParams<'hooks/trust'>): Promise<void>;
  /** Revokes every version approved for the repository of the root at `absPath`. */
  untrust(absPath: string): Promise<void>;
}

/** `request` is Main's own client of the host this app launched. */
export function createDesktopHookTrust(request: HostRequest): DesktopHookTrust {
  return {
    approval: async (absPath) => {
      const { approvedSha256 } = await request('hooks/trust/read', { path: absPath });
      return approvedSha256 ?? undefined;
    },
    trust: async (params) => {
      await request('hooks/trust', params);
    },
    untrust: async (absPath) => {
      await request('hooks/untrust', { path: absPath });
    },
  };
}
