import type {
  EmbeddingHostRuntimeMetadata,
  EmbeddingHostStatus,
} from '../../embedding-host-shared';

export interface EmbeddingHostStatusOptions {
  readonly active?: boolean;
  readonly commandId?: string;
  readonly embeddingRuntime?: EmbeddingHostRuntimeMetadata | null;
  readonly lastError?: string | null;
}

export function createEmbeddingHostStatus(
  runtimeId: string,
  state: EmbeddingHostStatus['state'],
  options?: EmbeddingHostStatusOptions
): EmbeddingHostStatus {
  return {
    active: options?.active ?? false,
    lastError: options?.lastError ?? null,
    runtimeId,
    runtimeKind: 'embedding-host',
    state,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
    ...(options?.embeddingRuntime ? { embeddingRuntime: options.embeddingRuntime } : {}),
  };
}
