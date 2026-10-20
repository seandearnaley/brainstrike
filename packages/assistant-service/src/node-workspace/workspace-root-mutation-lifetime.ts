import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import {
  beginWorkspacePhaseProof,
  type WorkspacePhaseProof,
  type WorkspacePhaseProofFields,
} from '@brainstrike/logging/workspace-phase-proof';

const logger = createLogger('WorkspaceRootMutationLifetime');

/** Terminal preparation joins accepted workflows without disposing their mounted capabilities. */
export class WorkspaceRootMutationLifetime {
  private tail: Promise<void> = Promise.resolve();
  private proofTailId = 0;
  private closing = false;
  private preparation: Promise<void> | undefined;
  private reservation: Promise<void> | undefined;
  private readonly failures: unknown[] = [];

  get proofPredecessorId(): number {
    return this.proofTailId;
  }

  get settled(): Promise<void> {
    return this.tail;
  }

  assertAdmission(): void {
    if (this.closing) {
      throw refusalError(
        'availability',
        'workspace.root-mutations-closed',
        'Workspace mutations are closing.',
        'Reopen the application to change workspace roots.'
      );
    }
  }

  run<T>(
    operation: (proof: WorkspacePhaseProof) => Promise<T>,
    assertOwned: () => void,
    admittedReservation: boolean,
    mutationName: NonNullable<WorkspacePhaseProofFields['mutationName']> = 'other'
  ): Promise<T> {
    const proof = beginWorkspacePhaseProof(logger, 'registry.mutation', {
      mutationName,
      queuedAfter: this.proofTailId,
    });
    try {
      assertOwned();
    } catch (cause) {
      proof.mark('settle', { status: 'failure' });
      return Promise.reject(cause);
    }
    if (!admittedReservation) {
      try {
        this.assertAdmission();
      } catch (cause) {
        proof.mark('settle', { status: 'failure' });
        return Promise.reject(cause);
      }
    }
    const execute = async (): Promise<T> => {
      proof.mark('start');
      assertOwned();
      return operation(proof);
    };
    const result = this.tail.then(execute, execute);
    this.proofTailId = proof.id;
    this.tail = result.then(
      () => {
        proof.mark('settle', { status: 'success' });
      },
      (cause: unknown) => {
        if (this.closing) {
          this.failures.push(cause);
        }
        proof.mark('settle', { status: 'failure' });
      }
    );
    return result;
  }

  reserve() {
    const released = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    const settled = Promise.race([released.promise, failed.promise]);
    void settled.catch(() => undefined);
    this.reservation = settled;
    return {
      release: (): void => {
        this.reservation = undefined;
        released.resolve();
      },
      track: <T>(attempt: Promise<T>): Promise<T> => {
        void attempt.catch((cause: unknown) => failed.reject(cause));
        return attempt;
      },
    };
  }

  prepareClose(): Promise<void> {
    this.closing = true;
    this.preparation ??= (async () => {
      // A reservation may enqueue after an asynchronous native transition.
      // Its owner alone releases it; settled failure remains visible and owned.
      const reserved = await Promise.allSettled([this.reservation]);
      await this.tail;
      const reservationFailures = reserved.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      const failures = [...new Set([...reservationFailures, ...this.failures])];
      if (reservationFailures.length > 0 && failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Workspace mutations failed during close preparation');
      }
    })();
    return this.preparation;
  }
}
