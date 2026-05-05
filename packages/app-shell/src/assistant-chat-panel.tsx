import type { ReactElement } from 'react';
import { AssistantUiPanelWrapperLazy } from './assistant-ui-panel-wrapper-lazy';
import { useAssistantAvailabilityWithLocal } from './hooks/use-assistant-availability-with-local';
import { McpBanner } from './mcp-banner';

export function AssistantChatPanel(): ReactElement {
  const status = useAssistantAvailabilityWithLocal();

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="assistant-chat-card">
      <div className="flex flex-shrink-0 flex-col space-y-1.5 px-4 py-3">
        <h3 className="font-semibold text-sm leading-none tracking-tight">Assistant</h3>
        <p className="text-muted-foreground text-xs">
          Chat with the Brainstrike assistant while working anywhere in the app.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-0">
        {status.state === 'loading' && (
          <div className="p-4 text-xs opacity-70">Checking assistant availability…</div>
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
              description="Configure an AI provider in Settings → LLM Provider Keys to enable the assistant."
              title="Assistant disabled"
              variant="warning"
              {...(status.reason ? { detail: `Reason: ${status.reason}` } : {})}
            />
          </div>
        )}
        {status.state === 'enabled' && (
          <>
            <div className="px-4 pb-2">
              <McpBanner />
            </div>
            <AssistantUiPanelWrapperLazy />
          </>
        )}
      </div>
    </div>
  );
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
