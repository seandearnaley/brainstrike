import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import React, { lazy, type ReactElement } from 'react';
import { useAssistantAvailability } from './hooks/use-assistant-availability';
import { McpBanner } from './mcp-banner';

const AssistantUiPanelLazy = lazy(async () => ({
  default: (await import('./assistant-ui-panel-wrapper')).AssistantUiPanelWrapper,
}));

export function AssistantTab(): ReactElement {
  const status = useAssistantAvailability();

  return (
    <Card className="flex h-full flex-col overflow-hidden" data-testid="assistant-chat-card">
      <CardHeader className="flex-shrink-0 pb-3">
        <CardTitle className="text-sm">Assistant</CardTitle>
        <CardDescription className="text-xs">
          Chat with the Brainstrike assistant for guidance while editing props.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
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
            <React.Suspense
              fallback={<div className="p-4 text-xs opacity-70">Loading assistant…</div>}
            >
              <AssistantUiPanelLazy />
            </React.Suspense>
          </>
        )}
      </CardContent>
    </Card>
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
