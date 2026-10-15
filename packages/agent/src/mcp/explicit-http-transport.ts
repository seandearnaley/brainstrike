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
 *
 * Redirects are left on the SDK's `redirectPolicy` default of `'same-origin'`
 * (new in client 2.3.0): a redirect is followed only while it stays on the
 * request's origin and keeps its method, and any other redirect fails the
 * request instead of silently moving the session — OAuth requests included.
 * That is the same rule as the rest of this module, so the default is
 * deliberately NOT widened to `'follow'`; a server that genuinely answers on
 * another origin is configured with that URL rather than discovered by
 * following it.
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
