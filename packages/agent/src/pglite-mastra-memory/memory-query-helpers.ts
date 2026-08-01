import type { MastraDBMessage } from '@mastra/core/memory';
import type {
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  ThreadOrderBy,
  ThreadSortDirection,
} from '@mastra/core/storage';
import type { PgliteDatabase, PgliteQueryValue } from './types';

export type MessageListArgs = (StorageListMessagesInput | StorageListMessagesByResourceIdInput) & {
  threadIds?: string[];
};
export type MessageIncludeItem = NonNullable<StorageListMessagesInput['include']>[number];

export const DEFAULT_THREADS_PER_PAGE = 100;
export const DEFAULT_MESSAGES_PER_PAGE = 40;
const THREAD_ORDER_FIELDS = new Set<ThreadOrderBy>(['createdAt', 'updatedAt']);
const THREAD_ORDER_DIRECTIONS = new Set<ThreadSortDirection>(['ASC', 'DESC']);

/** Inline run-event detail like "12 messages" / "1 record". */
export function formatCountDetail(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toOptionalDate(value: Date | string | null): Date | undefined {
  return value ? toDate(value) : undefined;
}

export function toJsonString(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

export function parseJsonRecord(
  value: Record<string, unknown> | string | null
): Record<string, unknown> | undefined {
  if (!value) {
    return;
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }
  return value;
}

export function parseJsonArray<TValue>(value: TValue[] | string | null): TValue[] | undefined {
  if (!value) {
    return;
  }
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as TValue[]) : undefined;
}

export function parseMessageContent(
  value: MastraDBMessage['content'] | string
): MastraDBMessage['content'] {
  if (typeof value !== 'string') {
    return value;
  }
  const parsed: unknown = JSON.parse(value);
  return parsed as MastraDBMessage['content'];
}

export function normalizePerPage(
  value: number | false | undefined,
  fallback: number
): number | false {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('perPage must be false or a non-negative safe integer');
  }
  return value;
}

export function normalizePage(value: number | undefined): number {
  const page = value ?? 0;
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new Error('page must be a non-negative safe integer');
  }
  return page;
}

export function pagination(total: number, page: number, perPage: number | false) {
  if (perPage === false) {
    return { hasMore: false, page: 0, perPage, total };
  }
  return {
    hasMore: (page + 1) * perPage < total,
    page,
    perPage,
    total,
  };
}

export function orderBySql(
  orderBy: { field?: ThreadOrderBy | 'createdAt'; direction?: ThreadSortDirection } | undefined,
  defaultField: ThreadOrderBy,
  defaultDirection: ThreadSortDirection
): string {
  const field = (orderBy?.field ?? defaultField) as ThreadOrderBy;
  const direction = orderBy?.direction ?? defaultDirection;
  if (!THREAD_ORDER_FIELDS.has(field)) {
    throw new Error(`Unsupported order field: ${field}`);
  }
  if (!THREAD_ORDER_DIRECTIONS.has(direction)) {
    throw new Error(`Unsupported order direction: ${direction}`);
  }
  return `"${field}" ${direction}, id ${direction}`;
}

export function normalizeMessageOrder(orderBy: StorageListMessagesInput['orderBy'] | undefined): {
  direction: ThreadSortDirection;
} {
  const field = orderBy?.field ?? 'createdAt';
  const direction = orderBy?.direction ?? 'DESC';
  if (field !== 'createdAt') {
    throw new Error(`Unsupported message order field: ${field}`);
  }
  if (!THREAD_ORDER_DIRECTIONS.has(direction)) {
    throw new Error(`Unsupported order direction: ${direction}`);
  }
  return { direction };
}

export function compareMessagesByOrder(
  left: MastraDBMessage,
  right: MastraDBMessage,
  order: { direction: ThreadSortDirection }
): number {
  const leftTime = toDate(left.createdAt).getTime();
  const rightTime = toDate(right.createdAt).getTime();
  const dateDelta = leftTime - rightTime;
  if (dateDelta !== 0) {
    return order.direction === 'ASC' ? dateDelta : -dateDelta;
  }
  return order.direction === 'ASC'
    ? left.id.localeCompare(right.id)
    : right.id.localeCompare(left.id);
}

export function normalizeIncludeWindowCount(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function normalizeIncludeThreadId(
  threadId: string | undefined,
  fallbackThreadId: string
): string {
  if (threadId === undefined) {
    return fallbackThreadId;
  }
  if (!threadId.trim()) {
    throw new Error('include.threadId must be a non-empty string when provided');
  }
  return threadId;
}

function messageMatchesListScope(message: MastraDBMessage, args: MessageListArgs): boolean {
  if (args.threadIds) {
    const threadId = message.threadId;
    if (!(threadId && args.threadIds.includes(threadId))) {
      return false;
    }
  }
  if (args.resourceId && message.resourceId !== args.resourceId) {
    return false;
  }
  return true;
}

function createdAtMatchesDateRange(createdAt: Date | string, args: MessageListArgs): boolean {
  const dateRange = args.filter?.dateRange;
  if (!dateRange) {
    return true;
  }
  const time = toDate(createdAt).getTime();
  if (dateRange.start) {
    const startTime = toDate(dateRange.start).getTime();
    if (dateRange.startExclusive ? time <= startTime : time < startTime) {
      return false;
    }
  }
  if (dateRange.end) {
    const endTime = toDate(dateRange.end).getTime();
    if (dateRange.endExclusive ? time >= endTime : time > endTime) {
      return false;
    }
  }
  return true;
}

export function messageMatchesListFilters(
  message: MastraDBMessage,
  args: MessageListArgs
): boolean {
  return (
    messageMatchesListScope(message, args) && createdAtMatchesDateRange(message.createdAt, args)
  );
}

export function appendLimit(
  sql: string,
  values: PgliteQueryValue[],
  page: number,
  perPage: number | false
): string {
  if (perPage === false) {
    return sql;
  }
  values.push(perPage);
  const limitIndex = values.length;
  values.push(page * perPage);
  const offsetIndex = values.length;
  return `${sql} LIMIT $${limitIndex} OFFSET $${offsetIndex}`;
}

export async function runTransaction<T>(
  database: PgliteDatabase,
  operation: (tx: PgliteDatabase) => Promise<T>
): Promise<T> {
  if (typeof database.transaction !== 'function') {
    throw new Error('PGlite memory store requires transaction support');
  }
  return database.transaction(operation);
}
