import {
  PROVIDER_DEFAULT_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import { useWorkspaceTabs } from '@brainstrike/file-explorer-ui/shell';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import { AssistantProviderModelDefaults } from './assistant-provider-model-defaults';
import { AssistantUiPanelWrapperLazy } from './assistant-ui-panel-wrapper-lazy';
import { AssistantProviderSourceProvider } from './hooks/assistant-provider-source';
import {
  type AssistantProviderReadError,
  useAssistantAvailability,
} from './hooks/use-assistant-availability';
import {
  AssistantProviderStatusContext,
  useAssistantProviderStatus,
  useAssistantStatusProviderSource,
} from './hooks/use-assistant-provider-status';
import { useHostAssistantStatusFetcher } from './hooks/use-host-assistant-status-fetcher';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

/**
 * Reads the host's assistant availability once, for the root panel and the
 * child conversation surfaces beside it, so every composer under it gates on
 * the providers the host has configured.
 */
export function AssistantProviderStatusProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const status = useAssistantAvailability(useHostAssistantStatusFetcher());
  return <AssistantProviderStatusContext value={status}>{children}</AssistantProviderStatusContext>;
}

export function AssistantChatPanel(): ReactElement {
  const status = useAssistantProviderStatus();
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
  const providerSource = useAssistantStatusProviderSource();
  const providerReadErrors =
    status.state === 'enabled' && status.providerErrors
      ? toProviderReadErrors(status.providerErrors)
      : undefined;
  // Links in thread markdown cannot use the anchor default: the desktop
  // renderer fences navigation and web would tear the SPA down. This is the
  // host end of that seam (BST-1665). A link's menu can drop over a browser
  // page beside the panel, which hides while the menu is open.
  const linkCapabilities = useAssistantLinkCapabilitiesValue(useWorkspaceTabs().onMenuOpenChange);

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
            <AssistantProviderModelDefaults
              {...(providerReadErrors ? { providerReadErrors } : {})}
            />
            <AssistantLinkCapabilitiesProvider capabilities={linkCapabilities}>
              <AssistantUiPanelWrapperLazy
                {...(providerReadErrors ? { providerReadErrors } : {})}
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
    default:
      return 'The assistant reported that it is turned off.';
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
