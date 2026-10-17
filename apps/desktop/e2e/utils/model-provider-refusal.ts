/**
 * The model-provider shim's refusals: a provider request it answers as the
 * provider would refuse it, either at the E2E egress boundary or as a request
 * that does not fit its model's context window.
 */
import type { ServerResponse } from 'node:http';
import type { ModelProviderRefusal } from './model-provider-shim';

function refusalMessage(refusal: ModelProviderRefusal): string {
  const request = `${refusal.method} ${refusal.route}${refusal.knob ? ` via ${refusal.knob}` : ''}`;
  switch (refusal.reason) {
    case 'unscripted':
      return `E2E egress boundary refused an unscripted provider request: ${request}. Script it through the canonical model-provider shim.`;
    case 'unrecorded-model-metadata':
      return `E2E egress boundary refused OpenRouter model metadata with no recorded fixture: ${request}.`;
    case 'unsupported-route':
      return `E2E egress boundary refused a provider request no scripted wire serves: ${request}.`;
    case 'unrecorded-exchange':
      return `E2E egress boundary refused a provider request its cassette never recorded: ${refusal.cassette?.key ?? request}. Unserved: ${refusal.cassette?.unserved.join(' | ') || 'none'}. Re-record the scenario if the host's conversation shape changed.`;
  }
}

/** OpenAI's refusal of a request that does not fit its model's context window. */
export function writeContextOverflow(response: ServerResponse): void {
  response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(
    JSON.stringify({
      error: {
        code: 'context_length_exceeded',
        message: "This model's maximum context length was exceeded.",
        param: 'input',
        type: 'invalid_request_error',
      },
    })
  );
}

export function writeRefusal(response: ServerResponse, refusal: ModelProviderRefusal): void {
  const message = refusalMessage(refusal);
  // 401, as the real providers answer the E2E fixture keys: no SDK retries it
  // (they retry 408, 409, 429 and 5xx), the runtime's stream-error retry
  // treats it as a terminal authorization failure, and a credential probe
  // reads it as invalid. A 403 would read as "authenticated but limited" and
  // auto-open the provider card; any non-auth 4xx is retried by the runtime.
  // The body satisfies each SDK's error parser: OpenAI/OpenRouter read
  // `error.message`; Anthropic reads `{ type: 'error', error: { type, message } }`.
  response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(
    JSON.stringify({
      error: { code: 'e2e_egress_refused', message, param: null, type: 'e2e_egress_refused' },
      type: 'error',
    })
  );
}
