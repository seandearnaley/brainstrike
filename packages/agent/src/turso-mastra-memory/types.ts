export type TursoMastraQueryValue =
  | null
  | string
  | number
  | boolean
  | Date
  | readonly TursoMastraQueryValue[]
  | Record<string, unknown>;

export type TursoMastraQueryValues = readonly TursoMastraQueryValue[];

export interface TursoMastraQueryResult<
  TRecord extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: TRecord[];
}

export interface TursoMastraSqlClient {
  exec(query: string, values?: TursoMastraQueryValues): Promise<unknown>;
  query<TRecord extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    values?: TursoMastraQueryValues
  ): Promise<TursoMastraQueryResult<TRecord>>;
  transaction?<T>(fn: (tx: TursoMastraSqlClient) => Promise<T>): Promise<T>;
}
