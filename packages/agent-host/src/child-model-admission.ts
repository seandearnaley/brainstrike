import {
  ChildModelError,
  type ChildModelTarget,
} from '@brainstrike/assistant-contract/child-model';
import type { HostRunState } from './core-state.ts';
import type { HostPlatform, HostRunAdmission, HostRunAdmissionRequest } from './ports.ts';
import type { HostRunSnapshot } from './protocol.ts';
import { acquireHostRunAdmission } from './run-admission.ts';

/**
 * ADR-0037: the selection a delegated child on `target` runs on. It is
 * admitted as its parent's own run would be on that model: the platform's
 * configuration for the child, under the root thread's intent, policy and
 * folders, through the same admission every run takes.
 */
export async function admitHostChildModel(
  platform: HostPlatform,
  parent: HostRunState,
  root: { readonly threadId: string } & Pick<HostRunAdmissionRequest, 'workspaceBinding'>,
  target: ChildModelTarget,
  runId: string
): Promise<{
  readonly admission: HostRunAdmission;
  readonly configuration: HostRunSnapshot['configuration'];
}> {
  if (!platform.childConfiguration) {
    throw new ChildModelError('This host runs subagents on their parent’s model only.');
  }
  const configuration = platform.childConfiguration(parent.input?.configuration, target);
  const admission = await acquireHostRunAdmission(platform, {
    configuration,
    modelId: target.modelId,
    ...(parent.input?.origin ? { origin: parent.input.origin } : {}),
    runId,
    signal: parent.controller.signal,
    ...root,
  });
  return { admission, configuration };
}
