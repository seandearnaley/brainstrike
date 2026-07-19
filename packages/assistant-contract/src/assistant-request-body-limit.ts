export const ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR =
  'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES';

/**
 * Default request body cap. Sized against the attachment contract: the 10MB
 * combined per-message attachment cap base64-encodes to ~13.4MB, leaving
 * prompt/history headroom. Desktop uses this canonical limit; transports with
 * a lower platform ceiling must enforce their own explicit maximum.
 */
export const DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Serialized request-body cap for the deployable Hosted Web transport.
 * Vercel Functions reject request or response bodies above 4.5 MB before
 * application code runs; 4 MiB stays below that platform boundary under both
 * decimal and binary interpretations.
 */
export const HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export class AssistantRequestBodyLimitConfigError extends Error {
  constructor() {
    super(`${ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR} must be a positive safe integer byte count.`);
    this.name = 'AssistantRequestBodyLimitConfigError';
  }
}

export function resolveAssistantRequestBodyLimitBytes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AssistantRequestBodyLimitConfigError();
  }
  return parsed;
}
