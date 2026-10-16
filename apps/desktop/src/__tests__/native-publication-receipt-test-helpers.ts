import type {
  CanonicalPublicationPort,
  CanonicalScanReceipt,
  NativeScopeReadiness,
} from '@brainstrike/canonical-ingestion';
import type { ScopedFilePlan, ScopedIndexerPort } from '@brainstrike/indexer';
import { expect } from 'vitest';

interface ReceiptAssertions {
  readonly commitTextFile: (
    publication: CanonicalPublicationPort
  ) => CanonicalPublicationPort['commitTextFile'];
  readonly expectReadiness: (
    actual: readonly NativeScopeReadiness[],
    expected: readonly Omit<NativeScopeReadiness, 'publication'>[]
  ) => void;
  readonly prepareScopedFile: ScopedIndexerPort['prepareScopedFile'];
}

/** Validate main's receipt against the real writer plan and the intercepted caller ticket. */
export function createNativePublicationReceiptAssertions(
  native: ScopedIndexerPort
): ReceiptAssertions {
  const prepared = new Map<string, ScopedFilePlan>();
  const acknowledgments = new Map<
    number,
    {
      readonly ticket: CanonicalScanReceipt['ticket'];
      readonly files: Set<string>;
      plan: ScopedFilePlan;
    }
  >();
  const expectReadiness = (
    actual: readonly NativeScopeReadiness[],
    expected: readonly Omit<NativeScopeReadiness, 'publication'>[]
  ): void => {
    expect(actual).toEqual(
      expected.map((row) => {
        const ack = acknowledgments.get(row.generation);
        if (!ack) {
          return row;
        }
        return {
          ...row,
          publication: {
            acknowledgedFiles: ack.files.size,
            authorityEpoch: ack.plan.authorityEpoch,
            authorityRevision: ack.plan.authorityRevision,
            generation: ack.ticket.generation,
            mutationRevision: row.mutationRevision,
            profileHash: ack.plan.profileHash,
            requestId: ack.ticket.requestId,
            storeId: ack.ticket.storeId,
          },
        };
      })
    );
  };
  return {
    commitTextFile: (publication) => async (request) => {
      await publication.commitTextFile(request);
      const plan = prepared.get(request.file.fileId);
      if (!plan) {
        throw new Error('The real writer did not prepare the acknowledged file.');
      }
      const previous = acknowledgments.get(request.ticket.generation);
      const files = previous?.files ?? new Set<string>();
      files.add(request.file.fileId);
      acknowledgments.set(request.ticket.generation, { files, plan, ticket: request.ticket });
    },
    expectReadiness,
    prepareScopedFile: async (request: Parameters<typeof native.prepareScopedFile>[0]) => {
      const plan = await native.prepareScopedFile(request);
      prepared.set(plan.snapshot.fileId, plan);
      return plan;
    },
  };
}
