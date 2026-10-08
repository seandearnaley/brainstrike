import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostMcpRuntime, HostStartupContext } from '@brainstrike/agent-host';
import type { ResolvedMcpConfig } from '@brainstrike/assistant-contract/mcp-config';
import type { ProviderCredentialReader } from '@brainstrike/assistant-service/ports';
import type { ProviderAuthProjectionOptions } from '@brainstrike/assistant-service/provider-credential-projection';
import type { McpTaskDatabase } from '@brainstrike/db';

/** Explicit selection only: failure never selects a different credential backend. */
export type AgentHostCredentialStoreOptions =
  | { readonly kind: 'keyring'; readonly service: string }
  | { readonly kind: 'file'; readonly path: string };

/** Process-local composition input. Neither credentials nor callbacks cross JSON-RPC. */
export interface AgentHostAdapterServicesOptions {
  readonly appUi: 'rich' | 'text';
  /** Explicit AWS/subscription capabilities retain the existing authentication restrictions. */
  readonly authProjectionOptions?: ProviderAuthProjectionOptions;
  readonly credentialStore: AgentHostCredentialStoreOptions;
  readonly mcpConfiguration: ResolvedMcpConfig;
  readonly openExternal: (url: string) => Promise<void>;
  /** Borrow the existing Tasks writer; the leaf must not construct another database. */
  readonly openTaskDatabase: () => Promise<McpTaskDatabase>;
  readonly root: string;
  /** Retain partial cleanup before the first credential/MCP side effect. */
  readonly startup: HostStartupContext;
}

/** Owned once per root. Admission borrows exact generation-qualified MCP bindings. */
export interface AgentHostAdapterServices {
  close(): Promise<void>;
  readonly mcp: HostMcpRuntime;
  readonly readProviderCredential: ProviderCredentialReader;
  resolveProviderAuth(provider: string): Promise<ProviderAuthInput | undefined>;
}

/** The adapter leaf implements this export in ./adapter-services.ts. */
export type CreateAgentHostAdapterServices = (
  options: AgentHostAdapterServicesOptions
) => Promise<AgentHostAdapterServices>;
