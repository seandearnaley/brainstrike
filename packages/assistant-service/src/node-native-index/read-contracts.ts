import type { CanonicalSourceScope } from '@brainstrike/canonical-ingestion';

export interface NativeScopeReadiness {
  readonly generation: number;
  readonly mutationRevision: number;
  readonly publication?: NativeAcknowledgedPublication;
  readonly scanComplete: boolean;
  readonly scope: CanonicalSourceScope;
}

export interface NativeAcknowledgedPublication {
  readonly acknowledgedFiles: number;
  readonly authorityEpoch: string;
  readonly authorityRevision: number;
  readonly generation: number;
  readonly mutationRevision: number;
  readonly profileHash: string | null;
  readonly requestId: string;
  readonly storeId: string;
}
