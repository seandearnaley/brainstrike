import { createContext, use, useSyncExternalStore } from 'react';

/** A count with the model's own words for it: tokens it read, cached, wrote and reasoned. */
export interface GenerationTokens {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly output: number;
  /** Part of `output`: the tokens the model spent reasoning, where its route reports them. */
  readonly reasoning: number;
}

/**
 * One generation: the run that wrote an assistant message, as its committed
 * log records it. Every figure is what the run reported; nothing is filled
 * in. An absent figure is one the run never reported.
 */
export interface GenerationDetails {
  /** The run's cost. `estimated` is priced from catalog rates, `billed` is what the provider reported. */
  readonly cost?: { readonly basis: 'billed' | 'estimated'; readonly usd: number } | undefined;
  /** The reasoning effort the run was admitted with ("high", or "Auto" for the model's own). */
  readonly effort?: string | undefined;
  /** Why the run's last model step stopped (`stop`, `tool-calls`, `length`…). */
  readonly finishReason?: string | undefined;
  /** From the run's first model request to its first output. */
  readonly firstOutputMs?: number | undefined;
  readonly model: { readonly id: string; readonly label: string };
  /** The model steps' own response time, without tool execution or approval waits. */
  readonly modelTimeMs?: number | undefined;
  /** How the run ended; absent while it runs. */
  readonly outcome?: 'completed' | 'failed' | 'interrupted' | 'stopped' | undefined;
  /** The route that served the run. */
  readonly provider: { readonly id: string; readonly name: string };
  /** The model the route reports serving, when it names one other than the one asked for. */
  readonly servedModel?: string | undefined;
  /** Model steps the run took; each tool round trip is one. */
  readonly steps: number;
  readonly tokens: GenerationTokens;
  readonly toolCalls?: number | undefined;
  /** The model's maker; absent for a model the catalog doesn't list. */
  readonly vendor?: { readonly id: string; readonly name: string } | undefined;
  /** From the run's start to its end, approval waits included. */
  readonly wallTimeMs?: number | undefined;
}

/** The facts of the runs a thread view shows, read by run ID. */
export interface GenerationDetailsSource {
  /** A run's details: the same object until that run's committed facts change. */
  read(runId: string): GenerationDetails | undefined;
  subscribe(listener: () => void): () => void;
}

const GenerationDetailsContext = createContext<GenerationDetailsSource | null>(null);

/** Binds a thread view's runs to its assistant messages; without it, messages show no generation mark. */
export const GenerationDetailsProvider = GenerationDetailsContext.Provider;

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** One run's details, kept current as its rows commit; undefined without a source or a run. */
export function useGenerationDetails(runId: string | undefined): GenerationDetails | undefined {
  const source = use(GenerationDetailsContext);
  const read = (): GenerationDetails | undefined =>
    source && runId ? source.read(runId) : undefined;
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIPTION, read, read);
}
