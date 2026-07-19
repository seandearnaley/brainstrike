import { HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/assistant-contract/assistant-request-body-limit';

type WebBodyLimitProps =
  | { readonly requestBodyLimitBytes: number }
  | { readonly requestBodyLimitBytes?: never };

export function webBodyLimitProps(desktopAssistantBackendAvailable: boolean): WebBodyLimitProps {
  return desktopAssistantBackendAvailable
    ? {}
    : { requestBodyLimitBytes: HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES };
}
