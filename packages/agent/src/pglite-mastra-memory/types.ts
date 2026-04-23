export type PgliteQueryValue =
  | null
  | string
  | number
  | boolean
  | Date
  | readonly PgliteQueryValue[]
  | Record<string, unknown>;

export type PgliteQueryValues = readonly PgliteQueryValue[];

export interface PgliteQueryResult<
  TRecord extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: TRecord[];
}

export interface PgliteDatabase {
  exec(query: string): Promise<unknown>;
  query<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    values?: PgliteQueryValues
  ): Promise<PgliteQueryResult<TRecord>>;
  transaction?<T>(fn: (tx: PgliteDatabase) => Promise<T>): Promise<T>;
}
