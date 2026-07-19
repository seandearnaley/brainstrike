import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '@brainstrike/assistant-contract/assistant-request-body-limit';
import type { ReactElement } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import { AssistantUiPanelWrapperLazy } from './assistant-ui-panel-wrapper-lazy';
import { useAssistantAvailabilityWithLocal } from './hooks/use-assistant-availability-with-local';

export interface AssistantChatPanelProps {
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
}

export function AssistantChatPanel({ loadLocalLlmBackend }: AssistantChatPanelProps): ReactElement {
  const status = useAssistantAvailabilityWithLocal();

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="assistant-chat-card">
      <div className="flex min-h-0 flex-1 flex-col p-0">
        {status.state === 'loading' && (
          <AssistantPanelLoadingState label="Checking assistant availability…" />
        )}
        {status.state === 'error' && (
          <div className="p-4">
            <AssistantStatusCallout
              description="Could not determine assistant status."
              detail={status.message}
              title="Assistant unavailable"
              variant="error"
            />
          </div>
        )}
        {status.state === 'disabled' && (
          <div className="p-4">
            <AssistantStatusCallout
              description={getAssistantDisabledDescription(status.reason)}
              title="Assistant disabled"
              variant="warning"
              {...(status.reason ? { detail: `Reason: ${status.reason}` } : {})}
            />
          </div>
        )}
        {status.state === 'enabled' && (
          <AssistantUiPanelWrapperLazy
            {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
            {...(status.provider && status.model
              ? {
                  fixedProviderModels: { [status.provider]: [status.model] },
                  initialProviders: [status.provider],
                }
              : {})}
          />
        )}
      </div>
    </div>
  );
}

function getAssistantDisabledDescription(reason: string | undefined): string {
  switch (reason) {
    case 'missing_api_key':
      return 'Configure an AI provider in Settings → LLM Provider Keys to enable the assistant.';
    case 'production_auth_required':
      return 'Use a protected Preview deployment, or add application authentication with distributed quota and cost controls before enabling the assistant publicly.';
    case 'invalid_request_body_limit_config':
      return `Set ${ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR} to a positive safe integer no greater than ${HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES}, then restart or redeploy the server.`;
    default:
      return 'The assistant status endpoint reported that the assistant is disabled.';
  }
}

function AssistantStatusCallout({
  title,
  description,
  detail,
  variant,
}: {
  title: string;
  description: string;
  detail?: string;
  variant: 'warning' | 'error';
}): ReactElement {
  const tone =
    variant === 'error'
      ? 'border-destructive/50 text-destructive'
      : 'border-muted-foreground/40 text-muted-foreground';

  return (
    <div
      className={`rounded-md border border-dashed p-3 text-xs leading-relaxed ${tone}`}
      data-testid="assistant-status-callout"
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1">{description}</div>
      {detail ? <div className="mt-1 text-[11px] opacity-80">{detail}</div> : null}
    </div>
  );
}
