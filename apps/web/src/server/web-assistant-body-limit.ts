import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantRequestBodyLimitConfigError,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveAssistantRequestBodyLimitBytes,
} from '@brainstrike/agent/request-boundary';

export const WEB_ASSISTANT_INVALID_REQUEST_BODY_LIMIT_REASON = 'invalid_request_body_limit_config';

export class WebAssistantRequestBodyLimitConfigError extends Error {
  constructor(configuredLimitBytes: number) {
    super(
      `${ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR} cannot exceed the Hosted Web ceiling of ${HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes; received ${configuredLimitBytes}.`
    );
    this.name = 'WebAssistantRequestBodyLimitConfigError';
  }
}

/**
 * Web may make the shared agent cap stricter, but it cannot exceed the
 * deployable transport's platform-safe ceiling.
 */
export function resolveWebAssistantRequestBodyLimitBytes(
  configuredValue: string | undefined
): number {
  if (configuredValue === undefined || configuredValue.trim() === '') {
    return HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES;
  }
  const configuredLimitBytes = resolveAssistantRequestBodyLimitBytes(configuredValue);
  if (configuredLimitBytes > HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES) {
    throw new WebAssistantRequestBodyLimitConfigError(configuredLimitBytes);
  }
  return configuredLimitBytes;
}

export function isWebAssistantRequestBodyLimitConfigError(
  error: unknown
): error is AssistantRequestBodyLimitConfigError | WebAssistantRequestBodyLimitConfigError {
  return (
    error instanceof AssistantRequestBodyLimitConfigError ||
    error instanceof WebAssistantRequestBodyLimitConfigError
  );
}
