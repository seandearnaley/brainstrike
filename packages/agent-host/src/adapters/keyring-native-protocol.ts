import { Schema } from 'effect';

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Account = Schema.String.check(Schema.isMinCodePoints(1));
/** Private worker messages only: never client JSON-RPC, events or diagnostic logs. */
export const KeyringNativeRequestSchema = Schema.Union(
  [
    Schema.Struct({ account: Account, id: Id, operation: Schema.Literal('read') }),
    Schema.Struct({
      account: Account,
      id: Id,
      operation: Schema.Literal('write'),
      value: Schema.String,
    }),
    Schema.Struct({ account: Account, id: Id, operation: Schema.Literal('delete') }),
    Schema.Struct({ id: Id, operation: Schema.Literal('listAccounts') }),
    Schema.Struct({ id: Id, operation: Schema.Literal('close') }),
  ],
  { mode: 'oneOf' }
);
export type KeyringNativeRequest = (typeof KeyringNativeRequestSchema)['Type'];
export const KeyringNativeResponseSchema = Schema.Union(
  [
    Schema.Struct({
      id: Id,
      ok: Schema.Literal(true),
      value: Schema.Union([
        Schema.String,
        Schema.Boolean,
        Schema.mutable(Schema.Array(Schema.String)),
        Schema.Null,
      ]),
    }),
    Schema.Struct({ id: Id, ok: Schema.Literal(false) }),
  ],
  { mode: 'oneOf' }
);
export interface KeyringNativeBackend {
  close(): Promise<void>;
  delete(account: string): Promise<boolean>;
  listAccounts(): Promise<readonly string[]>;
  read(account: string): Promise<string | undefined>;
  write(account: string, value: string): Promise<void>;
}
