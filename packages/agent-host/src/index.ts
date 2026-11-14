export { materializeHostProviderModel } from '@brainstrike/agent/provider-runtime';
export {
  canonicalToolModelOutput,
  createCanonicalToolContext,
  platformToolInputSchema,
  validateCanonicalToolInput,
} from './adapters/canonical-context.ts';
export {
  type AgentHostToolBinding,
  type AgentHostToolBindings,
  createAgentHostToolBindings,
} from './adapters/canonical-tool-bindings.ts';
export { hostToolDiscoveryEnabled } from './adapters/host-tool-discovery.ts';
export {
  createKeyringNativeBackend,
  type KeyringNativeBackend,
} from './adapters/keyring-native-worker.ts';
export { createMcpHostToolAdapter } from './adapters/mcp.ts';
export { hostChildCallSign } from './child-presentation.ts';
export {
  type HostCliDefaults,
  type HostCliOutput,
  runHostCli,
  runHostCliProcess,
} from './cli.ts';
export { attachAgentHost, authenticateHostClient, type HostClient } from './client.ts';
export {
  type CommittedRunIdentity,
  committedRowAddress,
  committedRunIdentity,
} from './committed-identities.ts';
export { committedTranscript } from './committed-transcript.ts';
export { bindHostConnection } from './connection.ts';
export { HostCore, type HostEventStore } from './core.ts';
export { readHostRow } from './event-storage.ts';
export {
  type HostHookTrustStore,
  hostProjectHooksPath,
  readHostHookApproval,
  trustHostHooks,
  untrustHostHooks,
} from './hook-trust.ts';
export { createAgentHostSpawner } from './launcher.ts';
export {
  assertMcpAuthorityReconstruction,
  McpAuthorityReconstructionError,
} from './mcp-authority.ts';
export {
  type HostPermissionPolicyStore,
  hostPermissionGate,
  readHostPermissionPolicy,
  writeHostPermissionPolicy,
} from './permission-policy.ts';
export {
  type HostEnvFileFailure,
  type HostPlatformLaunchOptions,
  HostPlatformLaunchOptionsSchema,
} from './platform-launch-options.ts';
export * from './ports.ts';
export {
  type HostPlatformFactory,
  type HostProcessParent,
  loadHostPlatform,
  runAgentHostProcess,
} from './process-entry.ts';
export {
  createProductionHostPlatform,
  type ProductionHostPlatformOptions,
  type ProductionHostRunConfiguration,
} from './production-platform.ts';
export * from './protocol.ts';
export {
  type AgentHost,
  AgentHostStartupError,
  type HostPlatformInitializer,
  type HostStartupContext,
  startAgentHost,
} from './runtime.ts';
export {
  type HostScratchFolderRoots,
  hostScratchFolders,
} from './scratch-folders.ts';
export { pendingRewindSnapshotTargets } from './thread-rewind.ts';
export { nodePortConnection, stdioConnection } from './transports.ts';
export {
  type HostWorkspaceTrustStore,
  readHostWorkspaceTrust,
  trustedHostWorkspaceRoots,
  writeHostWorkspaceTrust,
} from './workspace-trust.ts';
