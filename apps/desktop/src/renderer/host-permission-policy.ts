import type { HostClient } from '@brainstrike/agent-host/browser';
import { HostPermissionPolicySchema } from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import type { StateStorage } from 'zustand/middleware';

const PersistedEnvelopeSchema = Schema.Struct({ state: Schema.Unknown });
/**
 * The permission policy store's persistence on the desktop (BST-1930 stage e):
 * the agent host keeps the saved policy in its StateStore, and this window
 * reads and writes it there. The store's persisted envelope ({ state, version })
 * maps onto the host's typed policy; the store's partialize already leaves out
 * the session grants. A client whose host went away is dropped, so the next
 * request connects again.
 */
export function hostPermissionPolicyPersistence(
  connect: () => Promise<HostClient>,
  version: number
): StateStorage {
  let connecting: Promise<HostClient> | undefined;
  const client = (): Promise<HostClient> => {
    if (!connecting) {
      const attempt = connect();
      connecting = attempt;
      const forget = (): void => {
        if (connecting === attempt) {
          connecting = undefined;
        }
      };
      attempt.then((host) => host.closed.then(forget, forget), forget);
    }
    return connecting;
  };
  return {
    getItem: async () => {
      const { policy } = await (await client()).request('permissions/policy/read', {});
      return policy === null ? null : JSON.stringify({ state: policy, version });
    },
    removeItem: async () => {
      await (await client()).request('permissions/policy/write', { policy: null });
    },
    setItem: async (_name, value) => {
      const { state } = wireDecoder(PersistedEnvelopeSchema, { errors: 'all' })(JSON.parse(value));
      await (await client()).request('permissions/policy/write', {
        policy: Schema.decodeUnknownSync(HostPermissionPolicySchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(state),
      });
    },
  };
}
