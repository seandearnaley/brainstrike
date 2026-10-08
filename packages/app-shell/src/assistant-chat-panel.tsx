import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '@brainstrike/assistant-contract/assistant-request-body-limit';
import {
  PROVIDER_DEFAULT_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import { type ReactElement, useMemo } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import { AssistantUiPanelWrapperLazy } from './assistant-ui-panel-wrapper-lazy';
import {
  type AssistantProviderSource,
  AssistantProviderSourceProvider,
} from './hooks/assistant-provider-source';
import type {
  AssistantAvailabilityStatus,
  AssistantProviderReadError,
} from './hooks/use-assistant-availability';
import { useAssistantAvailabilityWithLocal } from './hooks/use-assistant-availability-with-local';
import { useHostAssistantStatusFetcher } from './hooks/use-host-assistant-status-fetcher';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

export interface AssistantChatPanelProps {
  readonly loadLocalLlmBackend?: LocalLlmBackendFactory;
}

export function AssistantChatPanel({ loadLocalLlmBackend }: AssistantChatPanelProps): ReactElement {
  const status = useAssistantAvailabilityWithLocal(useHostAssistantStatusFetcher());
  const fixedProviderModelsResolution = useMemo<FixedProviderModelsResolution>(() => {
    if (!(status.state === 'enabled' && status.provider && status.model)) {
      return { state: 'not-required' };
    }
    return resolveFixedProviderModels(status.provider, status.model, status.providers);
  }, [status]);
  const fixedProviderModels =
    fixedProviderModelsResolution.state === 'ready'
      ? fixedProviderModelsResolution.models
      : undefined;
  const providerSource = useMemo<AssistantProviderSource>(
    () => resolveAssistantProviderSource(status),
    [status]
  );
  // Links in thread markdown cannot use the anchor default: the desktop
  // renderer fences navigation and web would tear the SPA down. This is the
  // host end of that seam (BST-1665).
  const linkCapabilities = useAssistantLinkCapabilitiesValue();

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
        {status.state === 'enabled' && fixedProviderModelsResolution.state === 'error' && (
          <div className="p-4">
            <AssistantStatusCallout
              description="Could not validate the assistant provider configuration."
              detail={fixedProviderModelsResolution.message}
              title="Assistant unavailable"
              variant="error"
            />
          </div>
        )}
        {status.state === 'enabled' && fixedProviderModelsResolution.state !== 'error' && (
          <AssistantProviderSourceProvider source={providerSource}>
            <AssistantLinkCapabilitiesProvider capabilities={linkCapabilities}>
              <AssistantUiPanelWrapperLazy
                {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                {...(status.providerErrors
                  ? { providerReadErrors: toProviderReadErrors(status.providerErrors) }
                  : {})}
                {...(status.providerKeySources
                  ? { providerKeySources: status.providerKeySources }
                  : {})}
                {...(fixedProviderModels ? { fixedProviderModels } : {})}
              />
            </AssistantLinkCapabilitiesProvider>
          </AssistantProviderSourceProvider>
        )}
      </div>
    </div>
  );
}

function resolveAssistantProviderSource(
  status: AssistantAvailabilityStatus
): AssistantProviderSource {
  if (status.state === 'enabled' && status.provider && status.model) {
    return {
      kind: 'authoritative',
      providers: status.providers ?? [status.provider],
    };
  }
  if (status.state === 'enabled' && status.providers) {
    return { kind: 'discovery', seeds: status.providers };
  }
  return { kind: 'discovery' };
}

type FixedProviderModelsResolution =
  | { readonly state: 'not-required' }
  | {
      readonly models: Partial<Record<SupportedProvider, readonly string[]>>;
      readonly state: 'ready';
    }
  | { readonly message: string; readonly state: 'error' };

function resolveFixedProviderModels(
  primaryProvider: SupportedProvider,
  primaryModel: string,
  providers: readonly SupportedProvider[] | undefined
): FixedProviderModelsResolution {
  const fixedModels: Partial<Record<SupportedProvider, readonly string[]>> = {};
  for (const provider of providers ?? [primaryProvider]) {
    if (provider === primaryProvider) {
      fixedModels[provider] = [primaryModel];
      continue;
    }
    const defaultModel = PROVIDER_DEFAULT_MODELS[provider];
    if (!defaultModel) {
      return {
        message: `Assistant status provider ${provider} has no registry default model`,
        state: 'error',
      };
    }
    fixedModels[provider] = [defaultModel];
  }
  return { models: fixedModels, state: 'ready' };
}

function toProviderReadErrors(
  errors: readonly AssistantProviderReadError[]
): Partial<Record<AssistantProviderReadError['provider'], string>> {
  return Object.fromEntries(errors.map((error) => [error.provider, error.message]));
}

function getAssistantDisabledDescription(reason: string | undefined): string {
  switch (reason) {
    case 'missing_api_key':
      return 'Configure an AI provider in Settings → Providers to enable the assistant.';
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
