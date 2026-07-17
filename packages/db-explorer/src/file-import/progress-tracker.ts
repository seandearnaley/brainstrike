import type { ImportProgress } from '@brainstrike/db';

interface ProgressError {
  error: string;
  file: string;
}

type ProgressListener = (progress: ImportProgress) => void;

export class ImportProgressTracker {
  private readonly total: number;

  private readonly onProgress: ProgressListener | undefined;

  private progress: ImportProgress;

  private current: string | undefined;

  constructor(total: number, listener?: ProgressListener) {
    this.total = total;
    this.onProgress = listener;
    this.progress = {
      completed: 0,
      errors: [],
      total,
    };
  }

  emitInitial(): void {
    this.notify();
  }

  addError(entry: ProgressError): void {
    this.progress = {
      ...this.progress,
      errors: [...this.progress.errors, entry],
    };
    this.notify();
  }

  addErrors(entries: ProgressError[]): void {
    if (entries.length === 0) {
      return;
    }
    this.progress = {
      ...this.progress,
      errors: [...this.progress.errors, ...entries],
    };
    this.notify();
  }

  update(completed: number, current?: string): void {
    this.progress = {
      ...this.progress,
      completed: Math.min(completed, this.total),
    };
    this.current = current;
    this.notify();
  }

  clearCurrent(): void {
    if (this.current === undefined) {
      return;
    }
    this.current = undefined;
    this.notify();
  }

  snapshot(): ImportProgress {
    return {
      ...this.progress,
      ...(this.current ? { current: this.current } : {}),
      errors: [...this.progress.errors],
    };
  }

  complete(): ImportProgress {
    this.progress = {
      ...this.progress,
      completed: this.total,
    };
    this.current = undefined;
    return this.snapshot();
  }

  get errorCount(): number {
    return this.progress.errors.length;
  }

  private notify(): void {
    if (!this.onProgress) {
      return;
    }
    this.onProgress(this.snapshot());
  }
}
