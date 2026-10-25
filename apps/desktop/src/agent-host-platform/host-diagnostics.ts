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
import { NATIVE_INDEX_WORKFLOW_SCOPE } from '../native-index-effect-diagnostics';
import { PlatformDiagnosticRecordSchema } from './platform-wire';

/**
 * Reports delivery failure on the host's stderr only. Its own records never
 * cross: a failed delivery must not recursively attempt the same delivery.
 */
const DELIVERY_SCOPE = 'DesktopHostDiagnosticDelivery';
/** MCP's own tap already forwards these scopes at every level, and reports its own failures. */
const MCP_DELIVERY_SCOPE = 'DesktopMcpDiagnosticDelivery';

function forwarded(record: LogRecord): boolean {
  // The search index runs in the host (ADR-0029 stage 4); its workflow timeline stays in the
  // desktop's Logs at every level, as Main logged it there.
  if (record.scope === NATIVE_INDEX_WORKFLOW_SCOPE) {
    return true;
  }
  return (
    (record.level === LogLevel.ERROR || record.level === LogLevel.FATAL) &&
    record.scope !== DELIVERY_SCOPE &&
    record.scope !== MCP_DELIVERY_SCOPE &&
    !Schema.is(McpDiagnosticScopeSchema)(record.scope)
  );
}

/**
 * BST-2202: the agent host's error and fatal log records, with the correlation
 * ids they carry, and the search index's workflow timeline, delivered to Main's diagnostics the way MCP records are
 * (`createDesktopMcpDiagnostics`). The host's stderr keeps every record.
 * `send` is the raw platform request: a sender that logs its own failures
 * through a forwarded scope would feed them back to this tap.
 */
export function forwardHostDiagnostics(send: (record: unknown) => Promise<unknown>): {
  /** Stop forwarding, deliver what was accepted, and report any delivery failure. */
  close(): Promise<void>;
} {
  const deliveryLogger = createLogger(DELIVERY_SCOPE);
  const failures: unknown[] = [];
  let tail = Promise.resolve();
  const failed = (cause: unknown): void => {
    failures.push(cause);
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
      tail = tail
        .then(async () => {
          await send(wire);
        })
        .catch(failed);
    } catch (cause) {
      failed(cause);
    }
  });
  let closing: Promise<void> | undefined;
  return {
    close: () => {
      closing ??= (async () => {
        remove();
        let joined: Promise<void>;
        do {
          joined = tail;
          await joined;
        } while (joined !== tail);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Agent host diagnostic delivery failed');
        }
      })();
      return closing;
    },
  };
}
