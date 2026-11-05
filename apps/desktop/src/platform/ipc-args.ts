/**
 * MAIN-only renderer argument schemas (BST-2383). Every desktop IPC method
 * names an Effect Schema for its argument tuple; the one dispatcher decodes
 * the renderer's arguments with it after authorizing the sender and before
 * the handler runs. Contracts stay type-only so preloads never import Effect:
 * nothing a preload bundles may import this module.
 */
import { Result, Schema } from 'effect';
import type { Contract, InvokeKeys, IpcChannel } from './ipc-contract';

/** A channel's argument tuple decoder; its output must satisfy the declared arguments. */
export type ArgsSchema<Args extends readonly unknown[]> = Schema.Decoder<Readonly<Args>>;

/** One argument schema per invoke channel of a contract, pinned to the contract's types. */
export type ContractArgs<C extends Contract> = {
  readonly [K in InvokeKeys<C>]: C[K] extends IpcChannel<infer Args, unknown>
    ? ArgsSchema<Args>
    : never;
};

export const NoArgs = Schema.Tuple([]);

/** A string carrying at least one non-whitespace character. */
export const NonBlankString = Schema.String.check(Schema.isPattern(/\S/u));

/**
 * The dispatcher's decoder for one method. Undeclared fields and extra
 * arguments are rejected rather than stripped, so a renderer that drifts from
 * the contract fails visibly. Issues name the path and the expectation, never
 * the renderer's value.
 */
export function ipcArgsDecoder<Args extends readonly unknown[]>(
  method: string,
  schema: Schema.Decoder<Args>
): (raw: readonly unknown[]) => Args {
  const decode = Schema.decodeUnknownResult(schema, { errors: 'all', onExcessProperty: 'error' });
  return (raw) => {
    const result = decode(raw);
    if (Result.isFailure(result)) {
      throw new TypeError(
        `Desktop IPC ${method} received invalid arguments: ${result.failure.message}`
      );
    }
    return result.success;
  };
}
