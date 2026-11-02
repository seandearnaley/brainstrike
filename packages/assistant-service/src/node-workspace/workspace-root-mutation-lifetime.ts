import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';

/**
 * Terminal preparation joins accepted workflows without disposing their mounted capabilities.
 * A workflow's outcome stays its caller's: a failure that settles while closing, often the
 * shutdown's own cancellation, is not a close failure.
 */
export class WorkspaceRootMutationLifetime {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private preparation: Promise<void> | undefined;

  get settled(): Promise<void> {
    return this.tail;
  }

  private assertAdmission(): void {
    if (this.closing) {
      throw refusalError(
        'availability',
        'workspace.root-mutations-closed',
        'Workspace mutations are closing.',
        'Reopen the application to change workspace roots.'
      );
    }
  }

  run<T>(operation: () => Promise<T>, assertOwned: () => void): Promise<T> {
    try {
      assertOwned();
      this.assertAdmission();
    } catch (cause) {
      return Promise.reject(cause);
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

  prepareClose(): Promise<void> {
    this.closing = true;
    this.preparation ??= this.tail;
    return this.preparation;
  }
}
