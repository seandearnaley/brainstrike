/**
 * Provider CALL WARNINGS (BST-1701): the channel every AI SDK adapter uses to
 * report what it did NOT do with a request.
 *
 * The adapters do not 400 on a setting the selected model rejects: they DROP
 * the value and report it as an entry on `warnings` - one per rejected
 * feature, e.g. `{type:'unsupported', feature:'temperature', details:'...will
 * be ignored'}` on `claude-opus-5`. Until BST-1701 nothing in Brainstrike read
 * that array, so a user's explicit Prompt Workbench `temperature` vanished
 * with no notice. That is exactly the silent degradation AGENTS.md forbids.
 *
 * WHY THE CAPTURE LIVES HERE, at the model, and not on the Mastra stream.
 * On a streaming call the warnings ride the adapter's FIRST stream part
 * (`{type:'stream-start', warnings:[...]}`), and Mastra 1.64 discards that
 * part outright - `convertFullStreamChunkToMastra` returns `undefined` for
 * `stream-start`. Mastra's own `step-start.payload.warnings` is fed from
 * `stream.warnings` on the doStream RESULT, a field the v4 provider spec does
 * not define, so it arrives `[]` on every hosted provider. Measured against
 * the installed @mastra/core, not assumed. Consuming `step-start.warnings`
 * would therefore have been a mapping that can never fire - a fix reporting
 * nothing. This observer sits UNDER Mastra, where the array still exists.
 *
 * It is an OBSERVER, never a transform: `wrapModelWithCallWarningCapture`
 * forwards every call argument and every stream chunk untouched. BST-1699
 * established that no adapter is sent a sampling param on a default request
 * and pins it with wire-level tests; nothing here may change what goes out.
 * Contrast `prompt-transform-proxy.ts`, whose whole job IS rewriting the
 * outgoing prompt.
 *
 * TYPE-BLIND BY DESIGN. `warnings` is a whole provider signal, not a
 * temperature patch: the spec's `SharedV4Warning` union already carries
 * `unsupported`, `compatibility`, `deprecated` and `other`, and an adapter may
 * add more. Nothing here filters by `type` or names a sampling key; the two
 * text fields are read by FIELD NAME (`feature`/`setting`,
 * `details`/`message`), which is what keeps an unknown type readable.
 */
import { boundRunEventReason } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('MastraAgent');

/**
 * One provider warning, normalized across the spec's four shapes.
 *
 * `type` stays an open `string` rather than the spec's union: this consumer
 * must survive an adapter that adds a fifth kind, and a closed union here
 * would either drop it or force a cast at the boundary.
 */
export interface ProviderCallWarning {
  /** The provider's own explanation (`details` / `message`), when it gave one. */
  readonly detail?: string;
  /** What the warning is ABOUT (`feature` / `setting`), when the shape names one. */
  readonly subject?: string;
  readonly type: string;
}

/**
 * The `type` recorded for an entry whose shape this consumer cannot read.
 *
 * Deliberately still RECORDED. Dropping an unreadable warning would recreate
 * the defect one layer down: the provider reported something and the user
 * would hear nothing.
 */
export const UNRECOGNIZED_PROVIDER_WARNING_TYPE = 'unrecognized';

/**
 * Distinct warnings retained per run. A repeat is deduped rather than counted,
 * so this bounds only genuinely DIFFERENT reports: an adapter that mints a
 * unique message per step cannot grow the sink without bound.
 */
export const MAX_PROVIDER_CALL_WARNINGS = 20;

export interface ProviderCallWarningSink {
  /** Take everything recorded since the last drain; dedupe memory is kept. */
  drain(): readonly ProviderCallWarning[];
  /** Record a provider `warnings` array (any shape, including a non-array). */
  record(value: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return boundRunEventReason(value);
    }
  }
  return;
}

/**
 * Read one entry off a provider `warnings` array.
 *
 * Field names, not type names: `unsupported`/`compatibility` carry `feature` +
 * `details`, `deprecated` carries `setting` + `message`, `other` carries
 * `message` alone. Reading by field keeps a future type readable whenever it
 * reuses one of those names, and never special-cases a feature.
 */
export function readProviderCallWarning(value: unknown): ProviderCallWarning {
  if (typeof value === 'string' && value.length > 0) {
    return { detail: boundRunEventReason(value), type: UNRECOGNIZED_PROVIDER_WARNING_TYPE };
  }
  if (!isRecord(value)) {
    return { type: UNRECOGNIZED_PROVIDER_WARNING_TYPE };
  }
  const type = value['type'];
  const subject = readString(value, ['feature', 'setting']);
  const detail = readString(value, ['details', 'message']);
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(subject === undefined ? {} : { subject }),
    type:
      typeof type === 'string' && type.length > 0
        ? boundRunEventReason(type)
        : UNRECOGNIZED_PROVIDER_WARNING_TYPE,
  };
}

function warningSignature(warning: ProviderCallWarning): string {
  return [warning.type, warning.subject ?? '', warning.detail ?? ''].join('|');
}

export function createProviderCallWarningSink(): ProviderCallWarningSink {
  const seen = new Set<string>();
  let pending: ProviderCallWarning[] = [];
  let capacityReported = false;
  return {
    drain() {
      if (pending.length === 0) {
        return [];
      }
      const drained = pending;
      pending = [];
      return drained;
    },
    record(value: unknown) {
      if (!Array.isArray(value)) {
        // Not a report: an adapter with nothing to say omits the field or
        // sends `[]`. A non-array is never coerced into one.
        return;
      }
      for (const entry of value) {
        const warning = readProviderCallWarning(entry);
        const signature = warningSignature(warning);
        if (seen.has(signature)) {
          // The same call warning repeats on every step of a multi-step turn.
          // One fact, one row.
          continue;
        }
        if (seen.size >= MAX_PROVIDER_CALL_WARNINGS) {
          if (!capacityReported) {
            capacityReported = true;
            logger.warn('provider reported more distinct call warnings than one run surfaces', {
              code: 'provider_call_warning_capacity_reached',
              limit: MAX_PROVIDER_CALL_WARNINGS,
            });
          }
          return;
        }
        seen.add(signature);
        pending.push(warning);
      }
    },
  };
}

/** The model methods whose RESULT this observer reads. */
const OBSERVED_CALL_METHODS = new Set(['doGenerate', 'doStream']);

interface CallResultLike {
  stream?: unknown;
  warnings?: unknown;
}

/**
 * Forward every chunk untouched, recording the warnings the adapter reports on
 * its `stream-start`.
 *
 * A TransformStream rather than a manual reader loop so backpressure,
 * cancellation and errors keep the source stream's own semantics: this must be
 * invisible to the consumer in every respect except the recording.
 */
function tapStreamStartWarnings(
  stream: ReadableStream<unknown>,
  sink: ProviderCallWarningSink
): ReadableStream<unknown> {
  return stream.pipeThrough(
    new TransformStream<unknown, unknown>({
      transform(chunk, controller) {
        if (isRecord(chunk) && chunk['type'] === 'stream-start') {
          sink.record(chunk['warnings']);
        }
        controller.enqueue(chunk);
      },
    })
  );
}

function observeCallResult(result: unknown, sink: ProviderCallWarningSink): unknown {
  if (!isRecord(result)) {
    return result;
  }
  const typed = result as CallResultLike;
  // `doGenerate` reports warnings on the result itself; `doStream` reports
  // them on the first stream part. An adapter may do both, so neither branch
  // excludes the other.
  sink.record(typed.warnings);
  if (!(typed.stream instanceof ReadableStream)) {
    // No stream to tap: a `doGenerate` result, or a shape this observer has no
    // business rewriting. Returned exactly as the adapter built it.
    return result;
  }
  return { ...result, stream: tapStreamStartWarnings(typed.stream, sink) };
}

/**
 * Wrap a language model so every generation call's provider warnings land in
 * `sink`. Request arguments, every other property, and every stream chunk pass
 * through untouched.
 *
 * The two limits documented on `wrapModelWithCallTransform`
 * (`prompt-transform-proxy.ts`) apply here for the same reasons: non-wrapped
 * methods are re-bound per access so method identity is not stable, and a
 * model reconstructed from serialized config is unwrapped. Brainstrike
 * re-creates models through `createProvider` on every run, so every live
 * request path re-wraps.
 */
export function wrapModelWithCallWarningCapture<M extends object>(
  model: M,
  sink: ProviderCallWarningSink
): M {
  return new Proxy(model, {
    get(target, property) {
      // Read with the TARGET as receiver, not the proxy. Mastra's own
      // `ModelRouterLanguageModel` and the AI SDK wrapper classes hold their
      // state in `#private` fields; a prototype getter reading one with `this`
      // bound to the proxy throws `TypeError: Cannot read private member`. This
      // wrapper is applied to EVERY model the factory returns, so it must be
      // safe against that whole set rather than just the adapters that happen
      // to use plain properties today.
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') {
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property === 'string' && OBSERVED_CALL_METHODS.has(property)) {
        return async (...args: unknown[]) =>
          observeCallResult(await method.apply(target, args), sink);
      }
      return method.bind(target);
    },
  });
}
