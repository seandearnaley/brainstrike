import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';

/**
 * Terminal preparation joins accepted workflows without disposing their mounted capabilities.
 * A workflow's outcome stays its caller's: a failure that settles while closing, often the
 * shutdown's own cancellation, is not a close failure. Only a root data deletion's reservation,
 * which outlives its attempts, reports its failure to the close.
 */
export class WorkspaceRootMutationLifetime {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private preparation: Promise<void> | undefined;
  private reservation: Promise<void> | undefined;

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
    operation: () => Promise<T>,
    assertOwned: () => void,
    admittedReservation: boolean
  ): Promise<T> {
    try {
      assertOwned();
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (!admittedReservation) {
      try {
        this.assertAdmission();
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    const execute = async (): Promise<T> => {
      assertOwned();
      return operation();
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined
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
      const [reserved] = await Promise.allSettled([this.reservation]);
      await this.tail;
      if (reserved.status === 'rejected') {
        throw reserved.reason;
      }
    })();
    return this.preparation;
  }
}
