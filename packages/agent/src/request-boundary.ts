/**
 * Lightweight request-size configuration shared by Node transports.
 *
 * Keep this entrypoint independent from Mastra, providers, streaming, and local
 * inference so readiness probes can validate transport configuration without
 * tracing the assistant runtime.
 */
export {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantRequestBodyLimitConfigError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveAssistantRequestBodyLimitBytes,
} from '@brainstrike/assistant-contract/assistant-request-body-limit';
