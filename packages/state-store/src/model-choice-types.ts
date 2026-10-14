export interface ModelChoice {
  readonly enabled: boolean;
  readonly modelId: string;
  readonly providerId: string;
}
export interface ProviderChoice {
  readonly enabled: boolean;
  readonly providerId: string;
}
export type ModelChoiceRequest =
  | { readonly operation: 'snapshot' }
  | ({ readonly operation: 'provider' } & ProviderChoice)
  | { readonly operation: 'models'; readonly models: readonly ModelChoice[] }
  | {
      readonly operation: 'initialize';
      readonly providerId: string;
      readonly policy: 'all' | 'seed';
      readonly modelIds: readonly string[];
    };
export interface ModelChoiceSnapshot {
  readonly models: readonly ModelChoice[];
  readonly providers: readonly ProviderChoice[];
}
export interface ModelChoiceResult extends ModelChoiceSnapshot {
  readonly outcome?: 'initialized' | 'preserved';
  readonly previous?: ModelChoiceSnapshot;
}
export interface ModelChoicePort {
  modelChoices(request: ModelChoiceRequest): Promise<ModelChoiceResult>;
}
