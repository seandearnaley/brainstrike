/**
 * The type surface of the explicit HTTP MCP client: its transport, lifecycle
 * and fetch shapes, and the SDK-derived parameter/result aliases for every
 * operation the client forwards. Declarations only — no runtime behavior.
 */
import type {
  Client,
  InputRequiredResult,
  McpSubscription,
  SubscriptionFilter,
} from '@modelcontextprotocol/client';

export type ExplicitHttpMcpTransport = 'sse' | 'streamable-http';
export type ExplicitHttpMcpLifecycle = 'client-owned' | 'host-owned';
export type ExplicitHttpMcpUnexpectedCloseObserver = () => void | Promise<void>;

export type ExplicitHttpMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type { ExplicitHttpMcpAuthorizationCallbackSource } from './interactive-oauth-completion';

type SdkRequestOptions = NonNullable<Parameters<Client['callTool']>[1]>;
export type ExplicitHttpMcpRequestOptions = SdkRequestOptions;
export type ExplicitHttpMcpListRequestOptions = NonNullable<Parameters<Client['listTools']>[1]>;

export type ExplicitHttpMcpListToolsResult = Awaited<ReturnType<Client['listTools']>>;
export type ExplicitHttpMcpListToolsParams = NonNullable<Parameters<Client['listTools']>[0]>;
export type ExplicitHttpMcpListPromptsResult = Awaited<ReturnType<Client['listPrompts']>>;
export type ExplicitHttpMcpListPromptsParams = NonNullable<Parameters<Client['listPrompts']>[0]>;
export type ExplicitHttpMcpListResourcesResult = Awaited<ReturnType<Client['listResources']>>;
export type ExplicitHttpMcpListResourcesParams = NonNullable<
  Parameters<Client['listResources']>[0]
>;
export type ExplicitHttpMcpListResourceTemplatesResult = Awaited<
  ReturnType<Client['listResourceTemplates']>
>;
export type ExplicitHttpMcpListResourceTemplatesParams = NonNullable<
  Parameters<Client['listResourceTemplates']>[0]
>;
export type ExplicitHttpMcpTool = ExplicitHttpMcpListToolsResult['tools'][number];
export type ExplicitHttpMcpCallToolParams = Parameters<Client['callTool']>[0];
export type ExplicitHttpMcpCallToolResult = Awaited<ReturnType<Client['callTool']>>;
export type ExplicitHttpMcpInputRequiredResult = InputRequiredResult;
export type ExplicitHttpMcpReadResourceParams = Parameters<Client['readResource']>[0];
export type ExplicitHttpMcpReadResourceResult = Awaited<ReturnType<Client['readResource']>>;
export type ExplicitHttpMcpGetPromptParams = Parameters<Client['getPrompt']>[0];
export type ExplicitHttpMcpGetPromptResult = Awaited<ReturnType<Client['getPrompt']>>;
export type ExplicitHttpMcpCompleteParams = Parameters<Client['complete']>[0];
export type ExplicitHttpMcpCompleteResult = Awaited<ReturnType<Client['complete']>>;
export type ExplicitHttpMcpSubscription = McpSubscription;
export type ExplicitHttpMcpSubscriptionFilter = SubscriptionFilter;

export type ExplicitHttpMcpManualCallOptions = ExplicitHttpMcpRequestOptions & {
  allowInputRequired: true;
};
export type ExplicitHttpMcpNormalCallOptions = Omit<
  ExplicitHttpMcpRequestOptions,
  'allowInputRequired'
> & {
  allowInputRequired?: false;
};

export interface NegotiatedProtocolFacts {
  getNegotiatedProtocolVersion: () => ReturnType<Client['getNegotiatedProtocolVersion']>;
  getProtocolEra: () => ReturnType<Client['getProtocolEra']>;
  getServerCapabilities: () => ReturnType<Client['getServerCapabilities']>;
  getServerVersion: () => ReturnType<Client['getServerVersion']>;
}
