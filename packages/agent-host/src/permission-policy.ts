import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { HostMethodHandler } from './auth-connection.js';
import type { HostClientOrigin } from './ports.js';
import {
  type HostPermissionPolicy,
  HostPermissionPolicySchema,
} from './protocol-permission-policy.js';
/** The host's StateStore settings, where it alone keeps the saved permission policy. */
export type HostPermissionPolicyStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting'
>;
const POLICY_KEY = 'permissions/policy';
export async function readHostPermissionPolicy(
  store: HostPermissionPolicyStore
): Promise<HostPermissionPolicy | null> {
  const value = await store.getSetting(POLICY_KEY);
  return value === undefined
    ? null
    : Schema.decodeUnknownSync(HostPermissionPolicySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(JSON.parse(value));
}
/** Saves the policy, or with null clears it so the shipped default applies. */
export async function writeHostPermissionPolicy(
  store: HostPermissionPolicyStore,
  policy: HostPermissionPolicy | null
): Promise<void> {
  if (policy === null) {
    await store.deleteSetting(POLICY_KEY);
    return;
  }
  await store.setSetting(
    POLICY_KEY,
    JSON.stringify(
      Schema.decodeUnknownSync(HostPermissionPolicySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(policy)
    )
  );
}
/** The gate a saved policy enforces: with enforcement off, everything is allowed. */
export function hostPermissionGate(policy: HostPermissionPolicy): PermissionToolGateSnapshot {
  return {
    policies: policy.policies,
    yolo: policy.yolo || !policy.enforce,
    ...(Object.keys(policy.perToolOverrides).length > 0
      ? { perToolOverrides: policy.perToolOverrides }
      : {}),
  };
}
/**
 * The saved permission policy on one authenticated connection. Only the
 * desktop's private client reaches it: a client attached over the public
 * socket must not loosen the desktop user's tool permissions.
 */
export function bindHostPermissionPolicyMethods(
  handle: HostMethodHandler,
  store: HostPermissionPolicyStore,
  origin: HostClientOrigin
): void {
  const owner = (): HostPermissionPolicyStore => {
    if (origin !== 'desktop-ui') {
      throw new Error("The permission policy is available only to the desktop's private client");
    }
    return store;
  };
  handle('permissions/policy/read', async () => ({
    policy: await readHostPermissionPolicy(owner()),
  }));
  handle('permissions/policy/write', async ({ policy }) => {
    await writeHostPermissionPolicy(owner(), policy);
    return { policy };
  });
}
