import { type RuntimeData, resolveRequestPermissionPolicy } from '@brainstrike/agent';

/**
 * Build the TRUSTED runtime for a web assistant request (mirrors the desktop
 * assistant server's trust boundary). Lives in its own PGlite-free module so the
 * trust logic is unit-testable without a Node/PGlite environment.
 *
 * The runtime gate trusts `runtime.permissionPolicy`, so a client must NEVER set
 * it directly: STRIP any client-supplied `permissionPolicy`, then resolve the
 * client's `permissionPolicyRequest` into the SERVER-built snapshot (with
 * server-classified `riskByTool`). Without this, a normal web turn never marks
 * "ask" tools with `requireApproval` and they never suspend — the storage/resume
 * path would be unreachable dead code.
 */
export function resolveWebAssistantRuntime(
  data: RuntimeData | undefined,
  apiKey: string,
  signal?: AbortSignal
): RuntimeData {
  const {
    permissionPolicy: _ignoredClientPermissionPolicy,
    permissionPolicyRequest,
    ...restData
  } = data ?? {};
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);
  return {
    ...restData,
    apiKey,
    ...(signal ? { signal } : {}),
    ...(permissionPolicy ? { permissionPolicy } : {}),
  };
}
