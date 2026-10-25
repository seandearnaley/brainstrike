import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { McpDiagnosticScopeSchema } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import {
  addLogListener,
  createLogger,
  LogLevel,
  type LogRecord,
  redactSensitiveLogValue,
} from '@brainstrike/logging';
import { Schema } from 'effect';
import { PlatformDiagnosticRecordSchema } from './platform-wire';

/**
 * Reports delivery failure on the host's stderr only. Its own records never
 * cross: a failed delivery must not recursively attempt the same delivery.
 */
const DELIVERY_SCOPE = 'DesktopHostDiagnosticDelivery';
/** MCP's own tap already forwards these scopes at every level, and reports its own failures. */
const MCP_DELIVERY_SCOPE = 'DesktopMcpDiagnosticDelivery';

function forwarded(record: LogRecord): boolean {
  return (
    (record.level === LogLevel.ERROR || record.level === LogLevel.FATAL) &&
    record.scope !== DELIVERY_SCOPE &&
    record.scope !== MCP_DELIVERY_SCOPE &&
    !Schema.is(McpDiagnosticScopeSchema)(record.scope)
  );
}

/**
 * BST-2202: the agent host's error and fatal log records, with the correlation
 * ids they carry, delivered to Main's diagnostics the way MCP records are
 * (`createDesktopMcpDiagnostics`). The host's stderr keeps every record.
 * `send` is the raw platform request: a sender that logs its own failures
 * through a forwarded scope would feed them back to this tap.
 */
export function forwardHostDiagnostics(send: (record: unknown) => Promise<unknown>): {
  /** Stop forwarding. A record already sent reaches Main or fails on its own. */
  stop(): void;
} {
  const deliveryLogger = createLogger(DELIVERY_SCOPE);
  const failed = (cause: unknown): void => {
    deliveryLogger.error('Agent host diagnostic delivery failed', { error: cause });
  };
  const remove = addLogListener((record) => {
    if (!forwarded(record)) {
      return;
    }
    try {
      // LogRecord is already redacted by its producer. Bound cyclic and Error
      // values before the JSON-RPC serialization boundary, as MCP's tap does.
      const wire = wireDecoder(PlatformDiagnosticRecordSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({
        record: JSON.parse(
          JSON.stringify(
            redactSensitiveLogValue(record, [], new WeakMap(), {
              maxDepth: 32,
              repeatedValue: '[REPEATED: agent host diagnostic value]',
            })
          )
        ),
      });
      send(wire).catch(failed);
    } catch (cause) {
      failed(cause);
    }
  });
  return { stop: remove };
}
