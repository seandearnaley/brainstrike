/** Storage qualification borrows the recorded State text fixture and canonical row address. */
export { schema, text } from './state-schema.mjs';

/** @param {readonly {threadId: string, seq: number, event: unknown}[]} rows */
export function messages(rows) {
  return rows.flatMap((row) => {
    const event = row.event;
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      (event.type === 'text' || event.type === 'tool-result')
    ) {
      return [{ messageId: JSON.stringify([row.threadId, row.seq]), seq: row.seq }];
    }
    return [];
  });
}
