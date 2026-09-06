import { createLogger } from '@brainstrike/logging';
import type { Client } from '@modelcontextprotocol/client';

const logger = createLogger('McpServerFeatureEvents');

export type McpServerFeatureEventKind =
  | 'prompt-list-changed'
  | 'resource-list-changed'
  | 'resource-updated'
  | 'tool-list-changed';
export type McpServerFeatureEventDiagnosticSink = (
  event: McpServerFeatureEventKind,
  error: unknown
) => Promise<void> | void;

export const diagnoseMcpServerFeatureEventFailure: McpServerFeatureEventDiagnosticSink = (
  event,
  error
) => {
  logger.error('MCP server feature event subscriber failed', { error, event });
};

export function resolveMcpServerFeatureEventDiagnosticSink(
  value: unknown,
  clientName: string
): McpServerFeatureEventDiagnosticSink {
  if (value === undefined) {
    return diagnoseMcpServerFeatureEventFailure;
  }
  if (typeof value !== 'function') {
    throw new Error(`MCP client "${clientName}": onServerFeatureEventError must be a function`);
  }
  return value as McpServerFeatureEventDiagnosticSink;
}

export interface McpServerFeatureEventHandlers {
  onPromptListChanged?: (() => Promise<void> | void) | undefined;
  onResourceListChanged?: (() => Promise<void> | void) | undefined;
  onResourceUpdated?: ((uri: string) => Promise<void> | void) | undefined;
  onToolListChanged?: (() => Promise<void> | void) | undefined;
}

export class McpServerFeatureEventRegistry {
  private readonly subscribers = new Set<McpServerFeatureEventHandlers>();

  constructor(private readonly onDiagnostic: McpServerFeatureEventDiagnosticSink) {}

  install(client: Client): void {
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      await this.dispatch('tool-list-changed', (subscriber) => subscriber.onToolListChanged?.());
    });
    client.setNotificationHandler('notifications/prompts/list_changed', async () => {
      await this.dispatch('prompt-list-changed', (subscriber) =>
        subscriber.onPromptListChanged?.()
      );
    });
    client.setNotificationHandler('notifications/resources/list_changed', async () => {
      await this.dispatch('resource-list-changed', (subscriber) =>
        subscriber.onResourceListChanged?.()
      );
    });
    client.setNotificationHandler('notifications/resources/updated', async (notification) => {
      await this.dispatch('resource-updated', (subscriber) =>
        subscriber.onResourceUpdated?.(notification.params.uri)
      );
    });
  }

  subscribe(handlers: McpServerFeatureEventHandlers): () => void {
    this.subscribers.add(handlers);
    return () => this.subscribers.delete(handlers);
  }

  private async dispatch(
    event: McpServerFeatureEventKind,
    callback: (subscriber: McpServerFeatureEventHandlers) => Promise<void> | void | undefined
  ): Promise<void> {
    const subscriberResults = await Promise.allSettled(
      Array.from(this.subscribers, async (subscriber) => await callback(subscriber))
    );
    const diagnosticResults = await Promise.allSettled(
      subscriberResults.flatMap((result) =>
        result.status === 'rejected'
          ? [Promise.resolve().then(async () => await this.onDiagnostic(event, result.reason))]
          : []
      )
    );
    for (const result of diagnosticResults) {
      if (result.status === 'rejected') {
        logger.error('MCP server feature event diagnostic sink failed', {
          error: result.reason,
          event,
        });
      }
    }
  }
}
