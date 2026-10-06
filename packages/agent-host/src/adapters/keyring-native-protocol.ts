import { z } from 'zod';

const Id = z.number().int().positive();
const Account = z.string().min(1);
/** Private worker messages only: never client JSON-RPC, events or diagnostic logs. */
export const KeyringNativeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ account: Account, id: Id, operation: z.literal('read') }),
  z.strictObject({ account: Account, id: Id, operation: z.literal('write'), value: z.string() }),
  z.strictObject({ account: Account, id: Id, operation: z.literal('delete') }),
  z.strictObject({ id: Id, operation: z.literal('listAccounts') }),
  z.strictObject({ id: Id, operation: z.literal('close') }),
]);
export type KeyringNativeRequest = z.infer<typeof KeyringNativeRequestSchema>;
export const KeyringNativeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    id: Id,
    ok: z.literal(true),
    value: z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]),
  }),
  z.strictObject({ id: Id, ok: z.literal(false) }),
]);

export interface KeyringNativeBackend {
  close(): Promise<void>;
  delete(account: string): Promise<boolean>;
  listAccounts(): Promise<readonly string[]>;
  read(account: string): Promise<string | undefined>;
  write(account: string, value: string): Promise<void>;
}
