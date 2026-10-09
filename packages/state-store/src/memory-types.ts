/** Data-only port executed by the existing StateStore writer, never a second connection. */
export type MemoryJson =
  | null
  | boolean
  | number
  | string
  | readonly MemoryJson[]
  | MemoryJsonObject;
export interface MemoryJsonObject {
  readonly [key: string]: MemoryJson;
}
export type MemoryEntityKind = 'thread' | 'resource' | 'observation';
export interface MemoryEntity {
  readonly id: string;
  readonly kind: MemoryEntityKind;
  readonly payload: MemoryJsonObject;
  readonly threadId: string | null;
}
export interface MemorySnapshot {
  readonly entities: readonly MemoryEntity[];
  readonly revision: number;
  readonly value?: MemoryJson;
}
export type MemoryNativeMethod =
  | 'getThreadById'
  | 'saveThread'
  | 'updateThread'
  | 'listThreads'
  | 'getResourceById'
  | 'saveResource'
  | 'updateResource'
  | 'getObservationalMemory'
  | 'getObservationalMemoryHistory'
  | 'initializeObservationalMemory'
  | 'insertObservationalMemoryRecord'
  | 'updateActiveObservations'
  | 'updateBufferedObservations'
  | 'swapBufferedToActive'
  | 'createReflectionGeneration'
  | 'updateBufferedReflection'
  | 'swapBufferedReflectionToActive'
  | 'setReflectingFlag'
  | 'setObservingFlag'
  | 'setBufferingObservationFlag'
  | 'setBufferingReflectionFlag'
  | 'clearObservationalMemory'
  | 'setPendingMessageTokens'
  | 'updateObservationalMemoryConfig';
export interface MemoryNativeRequest {
  readonly arguments: readonly MemoryJson[];
  readonly method: MemoryNativeMethod;
  readonly operation: 'native';
  readonly ownerThreadId?: string;
  readonly resourceId: string;
}
export interface MemoryCalculation {
  readonly changes: readonly MemoryEntityChange[];
  readonly value: MemoryJson;
}
/** Mastra OM's observation token counter (`TokenCounter.countObservations`). */
export type ObservationTokenCounter = (text: string) => number;
export type MemoryNativeCalculator = (
  snapshot: MemorySnapshot,
  request: MemoryNativeRequest
) => Promise<MemoryCalculation>;
export type MemoryEntityChange =
  | { readonly operation: 'put'; readonly entity: MemoryEntity }
  | { readonly operation: 'remove'; readonly kind: MemoryEntityKind; readonly id: string };
export type MemoryDomainRequest = (
  | MemoryNativeRequest
  | { readonly operation: 'read'; readonly resourceId: string }
  | {
      readonly operation: 'commit';
      readonly resourceId: string;
      readonly expectedRevision: number;
      readonly changes: readonly MemoryEntityChange[];
    }
  | {
      readonly operation: 'purge-thread';
      readonly resourceId: string;
      readonly threadId: string;
      /**
       * The resource's shared records: erase all, keep all, or keep them and
       * remove only the thread's attributed observation sections (thread deletion).
       */
      readonly sharedResource: 'clear' | 'detach-thread' | 'preserve';
    }
  | { readonly operation: 'purge-resource'; readonly resourceId: string }
  | {
      /** Gap 17: the desktop's legacy workspace memory, imported once. */
      readonly operation: 'legacy-import';
      readonly resourceId: string;
      readonly at: string;
      /** The legacy resource as its native record (ISO dates), or null when the profile had none. */
      readonly resource: MemoryJsonObject | null;
      /** The legacy profile had resource-scope observations; they are recorded, never imported. */
      readonly resourceObservations: boolean;
    }
  /** The import's marker (`MemoryLegacyImport`) as the snapshot's `value`, or null before it ran. */
  | { readonly operation: 'legacy-import-status'; readonly resourceId: string }
) & { readonly ownerThreadId?: string };
/** What the one legacy workspace-memory import did, recorded with it. */
export interface MemoryLegacyImport {
  readonly at: string;
  readonly resourceId: string;
  readonly resourceObservations: boolean;
  readonly workingMemory: 'imported' | 'kept-host' | 'none';
}
export interface MemoryDomainPort {
  memory(request: MemoryDomainRequest): Promise<MemorySnapshot>;
}
