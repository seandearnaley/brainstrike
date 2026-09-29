import { getAssistantBridge } from '@brainstrike/assistant-contract';
import { useEffect, useState } from 'react';
import { assistantEndpointLogger, resolveAssistantEndpoint } from './assistant-endpoint';

/** Initial API URL for the data stream runtime (hosted providers). */
function resolveInitialAssistantApi(): string {
  const bridge = getAssistantBridge();
  return typeof bridge?.url === 'string' && bridge.url
    ? `${bridge.url}/assistant`
    : '/api/assistant';
}

export function useAssistantEndpointApi(): string {
  // API URL for the runtime; auth headers resolve per-request (assistant-endpoint.ts).
  const [api, setApi] = useState<string>(resolveInitialAssistantApi);

  useEffect(() => {
    let ignore = false;
    resolveAssistantEndpoint()
      .then((endpoint) => {
        if (!ignore && endpoint) {
          setApi(endpoint.api);
        }
      })
      .catch((error) => {
        // A bridge that exists but errors means a broken assistant — say so.
        assistantEndpointLogger.error('Failed to resolve assistant endpoint', { error });
      });
    return () => {
      ignore = true;
    };
  }, []);

  return api;
}
