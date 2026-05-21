import { WorkerRateLimitError } from './embedding-provider-runtime';

export interface ClassifiedWorkerFailure {
  backoffMs?: number;
  isTerminal: boolean;
  truncated: string;
}

export class JobProcessingError<TJob> extends Error {
  readonly originalError?: unknown;
  remainingJobs: TJob[];

  constructor(message: string, remainingJobs: TJob[], cause?: unknown) {
    super(message);
    this.name = 'JobProcessingError';
    this.remainingJobs = remainingJobs;
    this.originalError = cause;
  }
}

function parseStatusCode(message: string): number | undefined {
  const statusMatch = /status (\d{3})/i.exec(message);
  return statusMatch ? Number(statusMatch[1]) : undefined;
}

function parseHostedStatusCode(message: string): number | undefined {
  const hostedStatusMatch = /API error \((\d{3})/i.exec(message);
  return hostedStatusMatch ? Number(hostedStatusMatch[1]) : undefined;
}

export function summarizeErrorMessage(message: string, limit = 4000): string {
  if (message.length <= limit) {
    return message;
  }
  const separator = ' ...[truncated]... ';
  const available = limit - separator.length;
  if (available <= 0) {
    return message.slice(0, limit);
  }

  const head = Math.floor(available / 2);
  const tail = available - head;
  return `${message.slice(0, head)}${separator}${message.slice(message.length - tail)}`;
}

export function classifyFailure(error: unknown): ClassifiedWorkerFailure {
  const message = error instanceof Error ? error.message : String(error);
  const truncated = summarizeErrorMessage(message);

  const backoffMs =
    error instanceof WorkerRateLimitError && error.retryAfterMs ? error.retryAfterMs : undefined;

  const hostedStatusCode = parseHostedStatusCode(message);
  const isHostedTerminal =
    hostedStatusCode !== undefined &&
    hostedStatusCode >= 400 &&
    hostedStatusCode < 500 &&
    hostedStatusCode !== 429;

  const statusCode = parseStatusCode(message);
  const isExplicitTerminalStatus =
    statusCode !== undefined && [400, 401, 403, 422].includes(statusCode);

  const isTerminal =
    isExplicitTerminalStatus ||
    isHostedTerminal ||
    /context length exceeded/i.test(message) ||
    /invalid input/i.test(message);

  return {
    ...(backoffMs === undefined ? {} : { backoffMs }),
    isTerminal,
    truncated,
  };
}
