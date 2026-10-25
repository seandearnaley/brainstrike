import { refusalError } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import type { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.ts';
import type {
  HostClientOrigin,
  HostWorkspaceIndex,
  HostWorkspaceIndexMethod,
  HostWorkspaceIndexMethods,
} from './ports.ts';
import {
  WORKSPACE_INDEX_EVENT,
  WORKSPACE_INDEX_RESULT_SCHEMAS,
  WorkspaceIndexEventSchema,
} from './protocol.ts';

const logger = createLogger('AgentHostWorkspaceIndex');

/**
 * ADR-0029 stage 4: the desktop's native search index and its settings on one
 * authenticated connection. Only the desktop's private clients reach them; a
 * subscribed connection receives the current lifecycle and settings, then every
 * change until it closes.
 */
export function bindHostWorkspaceIndexMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  index: HostWorkspaceIndex | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let unsubscribe: (() => void) | undefined;
  const service = (): HostWorkspaceIndex => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.index-desktop-only',
        "The search index is available only to the desktop's private client"
      );
    }
    if (!index) {
      throw refusalError(
        'configuration',
        'workspace.index-unavailable',
        'The search index is unavailable on this host'
      );
    }
    return index;
  };
  // The index's statuses and observations are wider than the wire's; each result and event
  // leaves in its wire shape, since the client refuses an unknown key.
  const wireEvent = wireDecoder(WorkspaceIndexEventSchema, { errors: 'all' });
  const serve = <M extends HostWorkspaceIndexMethod>(method: M): void => {
    handle(method, async (params) => {
      const methods: HostWorkspaceIndexMethods = service();
      // Widened once: indexing the result map by a generic method is too deep for tsc.
      const schema: Schema.ConstraintDecoder<unknown> = WORKSPACE_INDEX_RESULT_SCHEMAS[method];
      return wireDecoder(schema, { errors: 'all' })(await methods[method](params));
    });
  };
  handle('index/subscribe', () => {
    const owner = service();
    unsubscribe ??= owner.subscribe((event) => {
      let wire: unknown;
      try {
        wire = wireEvent(event);
      } catch (cause) {
        logger.error('The search index sent a change its clients cannot read', {
          cause,
          type: event.type,
        });
        return;
      }
      connection.sendNotification(WORKSPACE_INDEX_EVENT, wire).catch(() => connection.dispose());
    });
    return { subscribed: true };
  });
  serve('index/config/read');
  serve('index/config/update');
  serve('index/coverage');
  serve('index/coverage-batch');
  serve('index/file-chunks');
  serve('index/grep');
  serve('index/rebuild');
  serve('index/retry');
  serve('index/roots-registered');
  serve('index/search');
  serve('index/status');
  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
