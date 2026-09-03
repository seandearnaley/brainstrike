/**
 * Transport construction for the explicit HTTP MCP client. The configured
 * transport is authoritative — there is no probing, URL rewriting, or fallback
 * between Streamable HTTP and legacy HTTP+SSE — and only Streamable HTTP
 * carries the registered-extension dispatch and result-type compatibility
 * bridges.
 *
 * Interactive OAuth completion and OAuth scope step-up are Streamable-HTTP-only.
 * They are not narrowed away here: `normalizeExplicitHttpClientOptions` rejects
 * both combinations for `sse` (via `createInteractiveOAuthCompletion` and
 * `normalizeOAuthStepUpOptions`), so `interactiveOAuth`, `maxStepUpRetries` and
 * `onInsufficientScope` are provably undefined by the time the SSE branch runs.
 */
import {
  type Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { NormalizedHttpClientOptions } from './explicit-http-client-options';
import { installRegisteredExtensionDispatch } from './registered-extension-dispatch';
import { installMcpResultTypeCompatibility } from './result-type-compatibility';

export type ExplicitHttpTransport = SSEClientTransport | StreamableHTTPClientTransport;

function unsupportedTransport(transport: never): never {
  throw new Error(`Unsupported explicit HTTP MCP transport: ${String(transport)}`);
}

export function createExplicitHttpTransport(
  options: NormalizedHttpClientOptions,
  client: Client
): ExplicitHttpTransport {
  const authProvider = options.interactiveOAuth?.authProvider ?? options.authProvider;
  switch (options.transport) {
    case 'sse':
      return new SSEClientTransport(options.url, {
        ...(options.authProvider ? { authProvider: options.authProvider } : {}),
        fetch: options.fetch,
      });
    case 'streamable-http':
      return installMcpResultTypeCompatibility(
        installRegisteredExtensionDispatch(
          new StreamableHTTPClientTransport(options.url, {
            ...(authProvider ? { authProvider } : {}),
            fetch: options.fetch,
            ...(options.maxStepUpRetries === undefined
              ? {}
              : { maxStepUpRetries: options.maxStepUpRetries }),
            ...(options.onInsufficientScope === undefined
              ? {}
              : { onInsufficientScope: options.onInsufficientScope }),
          }),
          options.extensionRegistry,
          options.extensionDispatchLedger
        ),
        options.protocol,
        () => client.getProtocolEra()
      );
    default:
      return unsupportedTransport(options.transport);
  }
}
