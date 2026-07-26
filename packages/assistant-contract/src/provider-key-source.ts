export type ProviderKeySource<Id extends string> =
  | {
      readonly envVar: string;
      readonly provider: Id;
      readonly source: 'env';
    }
  | {
      readonly envVar?: never;
      readonly provider: Id;
      readonly source: 'stored';
    };
