type AgentBrowserSafeSpecifier =
  | '@brainstrike/agent/client'
  | '@brainstrike/agent/provider-metadata'
  | '@brainstrike/agent/tool-metadata';

interface AliasEntry {
  readonly find: AgentBrowserSafeSpecifier;
  readonly replacement: string;
}

export declare function createAgentBrowserSafeAliasEntries(
  agentPackageDir: string
): readonly AliasEntry[];

export declare function createAgentBrowserSafeAliasMap(
  agentPackageDir: string
): Record<AgentBrowserSafeSpecifier, string>;
