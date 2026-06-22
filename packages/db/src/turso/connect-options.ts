import type { connect } from '@tursodatabase/database';

export type TursoDatabaseConnectOptions = NonNullable<Parameters<typeof connect>[1]>;

export function createTursoDatabaseConnectOptions(): TursoDatabaseConnectOptions {
  return {
    experimental: ['index_method'],
  } as TursoDatabaseConnectOptions;
}
