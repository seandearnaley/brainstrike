export interface SerializedDesktopError {
  readonly category?: string;
  readonly code?: string;
  readonly errors?: readonly SerializedDesktopError[];
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly step?: string;
}

export function serializeDesktopError(error: unknown): SerializedDesktopError {
  if (error instanceof Error) {
    return {
      ...(error instanceof AggregateError
        ? { errors: error.errors.map(serializeDesktopError) }
        : {}),
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record['category'] === 'string' ? { category: record['category'] } : {}),
      ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
      message:
        typeof record['message'] === 'string' ? record['message'] : 'Structured cleanup failure',
    };
  }
  return { message: String(error) };
}
